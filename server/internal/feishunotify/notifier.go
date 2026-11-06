// Package feishunotify pushes a member's inbox notifications to Feishu as
// direct messages from the deployment's Feishu login app.
//
// Delivery is opt-in per member and workspace through the
// `feishu_notifications` preference and follows the member's inbox group
// mutes. It subscribes to inbox:new after the inbox row is committed and
// never blocks the publisher: events go through a bounded queue, and a full
// queue drops the push, not the inbox row.
//
// Notifications on one issue are rate limited per recipient: the first one
// is sent immediately, and the ones that follow within Window are merged into
// a single message sent when the window closes. The window state lives in
// process memory, which matches the single backend replica deployment.
package feishunotify

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/integrations/lark"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// PreferenceKey is the notification preference that opts a member in.
// A missing key means off.
const PreferenceKey = "feishu_notifications"

// notifTypeToGroup mirrors the inbox's mapping in cmd/server so a muted
// group is muted on Feishu too. Types not listed are not configurable.
var notifTypeToGroup = map[string]string{
	"issue_assigned":     "assignments",
	"unassigned":         "assignments",
	"assignee_changed":   "assignments",
	"status_changed":     "status_changes",
	"new_comment":        "comments",
	"mentioned":          "mentions",
	"priority_changed":   "updates",
	"start_date_changed": "updates",
	"due_date_changed":   "updates",
	"task_completed":     "agent_activity",
	"task_failed":        "agent_activity",
	"agent_blocked":      "agent_activity",
	"agent_completed":    "agent_activity",
}

// Queries is the slice of generated queries the notifier reads.
type Queries interface {
	GetNotificationPreference(ctx context.Context, arg db.GetNotificationPreferenceParams) (db.NotificationPreference, error)
	GetUser(ctx context.Context, id pgtype.UUID) (db.User, error)
	GetAgent(ctx context.Context, id pgtype.UUID) (db.Agent, error)
	GetIssue(ctx context.Context, id pgtype.UUID) (db.Issue, error)
	GetWorkspace(ctx context.Context, id pgtype.UUID) (db.Workspace, error)
	GetIssueStatusEntryByKey(ctx context.Context, arg db.GetIssueStatusEntryByKeyParams) (db.IssueStatus, error)
}

// Config tunes a Notifier. Zero values take the defaults.
type Config struct {
	Credentials lark.InstallationCredentials
	// AppURL is the web origin issue links point at.
	AppURL string
	// Window is the per-recipient, per-issue merge window. Default 1 minute.
	Window time.Duration
	// MaxAttempts bounds sends per message. Default 3.
	MaxAttempts int
	// RetryBackoff is the delay before the second attempt; it doubles after
	// each failure. Default 2 seconds.
	RetryBackoff time.Duration
	// QueueSize bounds events waiting for the worker. Default 256.
	QueueSize int
	Logger    *slog.Logger
}

// Notifier delivers inbox notifications to Feishu.
type Notifier struct {
	q      Queries
	sender lark.DirectMessenger
	cfg    Config
	logger *slog.Logger
	queue  chan event

	mu      sync.Mutex
	windows map[windowKey]*window
	// inflight tracks sends and timers so tests and shutdown can wait.
	inflight sync.WaitGroup
}

type windowKey struct {
	workspaceID string
	recipientID string
	issueID     string
}

// window is an open rate-limit window for one recipient and issue. pending
// holds the notifications to merge when it closes.
type window struct {
	pending []event
}

// event is the part of an inbox:new item the notifier needs.
type event struct {
	ItemID      string
	WorkspaceID string
	RecipientID string
	IssueID     string
	Type        string
	Title       string
	Body        string
	ActorType   string
	ActorID     string
	Details     map[string]string
}

// New builds a Notifier. Call Register to subscribe it and Run to start the
// worker.
func New(q Queries, sender lark.DirectMessenger, cfg Config) *Notifier {
	if cfg.Window <= 0 {
		cfg.Window = time.Minute
	}
	if cfg.MaxAttempts <= 0 {
		cfg.MaxAttempts = 3
	}
	if cfg.RetryBackoff <= 0 {
		cfg.RetryBackoff = 2 * time.Second
	}
	if cfg.QueueSize <= 0 {
		cfg.QueueSize = 256
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	return &Notifier{
		q:       q,
		sender:  sender,
		cfg:     cfg,
		logger:  cfg.Logger,
		queue:   make(chan event, cfg.QueueSize),
		windows: make(map[windowKey]*window),
	}
}

// Register subscribes the notifier to inbox:new.
func (n *Notifier) Register(bus *events.Bus) {
	bus.Subscribe(protocol.EventInboxNew, n.handle)
}

// handle runs on the publisher's goroutine, so it only parses and enqueues.
func (n *Notifier) handle(e events.Event) {
	ev, ok := parseInboxEvent(e)
	if !ok {
		return
	}
	select {
	case n.queue <- ev:
	default:
		n.logger.Warn("feishu notify: queue full; dropping push",
			"workspace_id", ev.WorkspaceID, "recipient_id", ev.RecipientID, "inbox_item_id", ev.ItemID)
	}
}

// Run processes queued events until ctx is done.
func (n *Notifier) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case ev := <-n.queue:
			n.accept(ctx, ev)
		}
	}
}

// accept checks eligibility and either sends now or merges into the open
// window for this recipient and issue.
func (n *Notifier) accept(ctx context.Context, ev event) {
	lookupCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if !n.eligible(lookupCtx, ev) {
		return
	}
	key := windowKey{workspaceID: ev.WorkspaceID, recipientID: ev.RecipientID, issueID: ev.IssueID}

	n.mu.Lock()
	if w, open := n.windows[key]; open {
		w.pending = append(w.pending, ev)
		n.mu.Unlock()
		return
	}
	n.windows[key] = &window{}
	n.inflight.Add(1)
	n.mu.Unlock()

	n.inflight.Add(1)
	go func() {
		defer n.inflight.Done()
		n.deliver(ctx, []event{ev})
	}()
	time.AfterFunc(n.cfg.Window, func() {
		defer n.inflight.Done()
		n.closeWindow(ctx, key)
	})
}

// closeWindow sends what accumulated in the window. When something did, a
// new window opens so the issue stays limited to one message per Window.
func (n *Notifier) closeWindow(ctx context.Context, key windowKey) {
	n.mu.Lock()
	w := n.windows[key]
	if w == nil || len(w.pending) == 0 {
		delete(n.windows, key)
		n.mu.Unlock()
		return
	}
	batch := w.pending
	w.pending = nil
	n.inflight.Add(1)
	n.mu.Unlock()

	n.deliver(ctx, batch)
	time.AfterFunc(n.cfg.Window, func() {
		defer n.inflight.Done()
		n.closeWindow(ctx, key)
	})
}

// Wait blocks until every pending send and window has finished. Tests use it.
func (n *Notifier) Wait() { n.inflight.Wait() }

func (n *Notifier) eligible(ctx context.Context, ev event) bool {
	workspaceID, err := util.ParseUUID(ev.WorkspaceID)
	if err != nil {
		return false
	}
	recipientID, err := util.ParseUUID(ev.RecipientID)
	if err != nil {
		return false
	}
	pref, err := n.q.GetNotificationPreference(ctx, db.GetNotificationPreferenceParams{WorkspaceID: workspaceID, UserID: recipientID})
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			n.logger.Warn("feishu notify: load preferences failed", "recipient_id", ev.RecipientID, "error", err)
		}
		return false
	}
	var prefs map[string]string
	if err := json.Unmarshal(pref.Preferences, &prefs); err != nil {
		return false
	}
	if !Enabled(prefs) {
		return false
	}
	if group, ok := notifTypeToGroup[ev.Type]; ok && prefs[group] == "muted" {
		return false
	}
	return true
}

// Enabled reports whether a preference map opts in to Feishu notifications.
func Enabled(prefs map[string]string) bool {
	return prefs[PreferenceKey] == "all"
}

// Recipient picks the Feishu identity a user is addressed by. open_id is
// issued by the login app that sends, so it is preferred; union_id covers a
// user linked through another app of the same developer.
func Recipient(u db.User) (receiveIDType, receiveID string, ok bool) {
	if u.FeishuOpenID.Valid && u.FeishuOpenID.String != "" {
		return lark.ReceiveIDTypeOpenID, u.FeishuOpenID.String, true
	}
	if u.FeishuUnionID.Valid && u.FeishuUnionID.String != "" {
		return lark.ReceiveIDTypeUnionID, u.FeishuUnionID.String, true
	}
	return "", "", false
}

func (n *Notifier) deliver(ctx context.Context, batch []event) {
	if len(batch) == 0 {
		return
	}
	first := batch[0]
	lookupCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	recipientID, _ := util.ParseUUID(first.RecipientID)
	user, err := n.q.GetUser(lookupCtx, recipientID)
	if err != nil {
		cancel()
		n.logger.Warn("feishu notify: load recipient failed", "recipient_id", first.RecipientID, "error", err)
		return
	}
	receiveIDType, receiveID, ok := Recipient(user)
	if !ok {
		cancel()
		n.logger.Debug("feishu notify: recipient has no Feishu identity; skipping", "recipient_id", first.RecipientID)
		return
	}
	card, err := n.render(lookupCtx, batch)
	cancel()
	if err != nil {
		n.logger.Warn("feishu notify: render card failed", "issue_id", first.IssueID, "error", err)
		return
	}

	backoff := n.cfg.RetryBackoff
	for attempt := 1; attempt <= n.cfg.MaxAttempts; attempt++ {
		sendCtx, sendCancel := context.WithTimeout(ctx, 15*time.Second)
		_, err = n.sender.SendUserCard(sendCtx, lark.SendUserCardParams{
			Credentials:   n.cfg.Credentials,
			ReceiveIDType: receiveIDType,
			ReceiveID:     receiveID,
			CardJSON:      card,
		})
		sendCancel()
		if err == nil {
			return
		}
		if attempt == n.cfg.MaxAttempts || !retryable(err) {
			break
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff *= 2
	}
	n.logger.Warn("feishu notify: send failed",
		"recipient_id", first.RecipientID, "issue_id", first.IssueID, "notifications", len(batch), "error", err)
}

// retryable rejects Lark business errors that a retry cannot fix, such as
// an invalid recipient or a user outside the app's availability.
func retryable(err error) bool {
	var apiErr *lark.APIError
	if errors.As(err, &apiErr) {
		return apiErr.Code >= 99991000
	}
	return true
}

func parseInboxEvent(e events.Event) (event, bool) {
	payload, ok := e.Payload.(map[string]any)
	if !ok {
		return event{}, false
	}
	item, ok := payload["item"].(map[string]any)
	if !ok {
		return event{}, false
	}
	if s, _ := item["recipient_type"].(string); s != "member" {
		return event{}, false
	}
	ev := event{
		ItemID:      stringField(item, "id"),
		WorkspaceID: stringField(item, "workspace_id"),
		RecipientID: stringField(item, "recipient_id"),
		IssueID:     stringField(item, "issue_id"),
		Type:        stringField(item, "type"),
		Title:       stringField(item, "title"),
		Body:        stringField(item, "body"),
		ActorType:   stringField(item, "actor_type"),
		ActorID:     stringField(item, "actor_id"),
		Details:     detailsField(item["details"]),
	}
	if ev.WorkspaceID == "" {
		ev.WorkspaceID = e.WorkspaceID
	}
	if ev.WorkspaceID == "" || ev.RecipientID == "" || ev.IssueID == "" {
		return event{}, false
	}
	return ev, true
}

// stringField reads a string or *string field from an inbox item map.
func stringField(item map[string]any, key string) string {
	switch v := item[key].(type) {
	case string:
		return v
	case *string:
		if v != nil {
			return *v
		}
	}
	return ""
}

func detailsField(v any) map[string]string {
	var raw []byte
	switch d := v.(type) {
	case json.RawMessage:
		raw = d
	case []byte:
		raw = d
	case map[string]string:
		return d
	case map[string]any:
		out := make(map[string]string, len(d))
		for k, val := range d {
			if s, ok := val.(string); ok {
				out[k] = s
			}
		}
		return out
	default:
		return nil
	}
	var out map[string]string
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil
	}
	return out
}
