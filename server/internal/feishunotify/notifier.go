// Package feishunotify pushes a member's inbox notifications to Feishu as
// direct messages. Only the Feishu bot of the agent the issue is assigned to
// sends them, so they land in the member's chat with that agent. Issues
// assigned to a member or unassigned, agents without a bot, and members the
// bot cannot reach get no push; the deployment's Feishu login app never sends
// notifications.
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

// BotRouter resolves an agent's Feishu bot and how a member is addressed
// through it. lark.ErrNoAgentBot and lark.ErrAgentBotRecipientUnreachable
// mean the notification is not pushed.
type BotRouter interface {
	Route(ctx context.Context, workspaceID, agentID pgtype.UUID, user db.User) (lark.AgentBotRoute, error)
}

// Config tunes a Notifier. Zero values take the defaults.
type Config struct {
	// Bots resolves agent bots. Nil pushes nothing.
	Bots BotRouter
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
	// buttons supplies plugin card buttons; see buttons_fork.go.
	buttons buttonProviderSlot
}

// windowKey includes the sending agent so a reassignment inside a window
// opens a new window for the new sender instead of merging into the old one.
type windowKey struct {
	workspaceID string
	recipientID string
	issueID     string
	// agentID is the assigned agent whose bot sends.
	agentID string
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
	agentID, reason := n.assignedAgent(lookupCtx, ev)
	if agentID == "" {
		n.logger.Info("feishu notify: not sent",
			"recipient_id", ev.RecipientID, "issue_id", ev.IssueID, "inbox_item_id", ev.ItemID, "reason", reason)
		return
	}
	key := windowKey{
		workspaceID: ev.WorkspaceID,
		recipientID: ev.RecipientID,
		issueID:     ev.IssueID,
		agentID:     agentID,
	}

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
		n.deliver(ctx, key, []event{ev})
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

	n.deliver(ctx, key, batch)
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

// Reasons a notification is not pushed, logged at INFO.
const (
	reasonNoBotRouter      = "agent bots not configured"
	reasonIssueLookup      = "issue lookup failed"
	reasonNotAgentAssigned = "issue not assigned to an agent"
	reasonNoAgentBot       = "no agent bot for issue"
	reasonUnreachable      = "recipient unreachable via bot"
	reasonBotLookup        = "bot lookup failed"
	reasonBotSendFailed    = "bot send failed"
)

// assignedAgent returns the issue's assigned agent, or "" and the reason no
// bot can send.
func (n *Notifier) assignedAgent(ctx context.Context, ev event) (string, string) {
	if n.cfg.Bots == nil {
		return "", reasonNoBotRouter
	}
	issueID, err := util.ParseUUID(ev.IssueID)
	if err != nil {
		return "", reasonIssueLookup
	}
	issue, err := n.q.GetIssue(ctx, issueID)
	if err != nil {
		n.logger.Warn("feishu notify: load issue assignee failed", "issue_id", ev.IssueID, "error", err)
		return "", reasonIssueLookup
	}
	if issue.AssigneeType.String != "agent" || !issue.AssigneeID.Valid {
		return "", reasonNotAgentAssigned
	}
	return util.UUIDToString(issue.AssigneeID), ""
}

func (n *Notifier) deliver(ctx context.Context, key windowKey, batch []event) {
	if len(batch) == 0 {
		return
	}
	first := batch[0]
	lookupCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	recipientID, _ := util.ParseUUID(first.RecipientID)
	user, err := n.q.GetUser(lookupCtx, recipientID)
	if err != nil {
		n.logger.Warn("feishu notify: load recipient failed", "recipient_id", first.RecipientID, "error", err)
		return
	}
	card, err := n.render(lookupCtx, batch)
	if err != nil {
		n.logger.Warn("feishu notify: render card failed", "issue_id", first.IssueID, "error", err)
		return
	}

	n.sendViaAgentBot(ctx, lookupCtx, key, user, card, len(batch))
}

// sendViaAgentBot sends through the assigned agent's bot. Every miss is
// logged with its reason; nothing else sends in its place.
func (n *Notifier) sendViaAgentBot(ctx, lookupCtx context.Context, key windowKey, user db.User, card string, count int) {
	logArgs := []any{"recipient_id", key.recipientID, "issue_id", key.issueID, "agent_id", key.agentID, "notifications", count}
	workspaceID, err := util.ParseUUID(key.workspaceID)
	if err != nil {
		return
	}
	agentID, err := util.ParseUUID(key.agentID)
	if err != nil {
		return
	}
	route, err := n.cfg.Bots.Route(lookupCtx, workspaceID, agentID, user)
	if err != nil {
		reason := reasonBotLookup
		switch {
		case errors.Is(err, lark.ErrNoAgentBot):
			reason = reasonNoAgentBot
		case errors.Is(err, lark.ErrAgentBotRecipientUnreachable):
			reason = reasonUnreachable
		}
		n.logger.Info("feishu notify: not sent", append(logArgs, "reason", reason, "error", err)...)
		return
	}
	logArgs = append(logArgs, "installation_id", util.UUIDToString(route.InstallationID), "receive_id_type", route.ReceiveIDType)
	err = n.send(ctx, lark.SendUserCardParams{
		Credentials:   route.Credentials,
		ReceiveIDType: route.ReceiveIDType,
		ReceiveID:     route.ReceiveID,
		CardJSON:      card,
	})
	if err != nil {
		n.logger.Info("feishu notify: not sent", append(logArgs, "reason", reasonBotSendFailed, "error", err)...)
		return
	}
	n.logger.Info("feishu notify: sent via agent bot", logArgs...)
}

// send posts one card, retrying transient failures with backoff.
func (n *Notifier) send(ctx context.Context, p lark.SendUserCardParams) error {
	var err error
	backoff := n.cfg.RetryBackoff
	for attempt := 1; attempt <= n.cfg.MaxAttempts; attempt++ {
		sendCtx, sendCancel := context.WithTimeout(ctx, 15*time.Second)
		_, err = n.sender.SendUserCard(sendCtx, p)
		sendCancel()
		if err == nil {
			return nil
		}
		if attempt == n.cfg.MaxAttempts || !retryable(err) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
		}
		backoff *= 2
	}
	return err
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
