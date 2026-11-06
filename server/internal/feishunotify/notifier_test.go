package feishunotify

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/integrations/lark"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

const (
	testWorkspaceID = "11111111-1111-1111-1111-111111111111"
	testRecipientID = "22222222-2222-2222-2222-222222222222"
	testActorID     = "33333333-3333-3333-3333-333333333333"
	testIssueID     = "44444444-4444-4444-4444-444444444444"
	otherIssueID    = "55555555-5555-5555-5555-555555555555"
)

type fakeQueries struct {
	prefs map[string]string // nil means no row
	users map[string]db.User
}

func (f *fakeQueries) GetNotificationPreference(_ context.Context, _ db.GetNotificationPreferenceParams) (db.NotificationPreference, error) {
	if f.prefs == nil {
		return db.NotificationPreference{}, pgx.ErrNoRows
	}
	raw, _ := json.Marshal(f.prefs)
	return db.NotificationPreference{Preferences: raw}, nil
}

func (f *fakeQueries) GetUser(_ context.Context, id pgtype.UUID) (db.User, error) {
	u, ok := f.users[util.UUIDToString(id)]
	if !ok {
		return db.User{}, pgx.ErrNoRows
	}
	return u, nil
}

func (f *fakeQueries) GetAgent(_ context.Context, _ pgtype.UUID) (db.Agent, error) {
	return db.Agent{Name: "Builder"}, nil
}

func (f *fakeQueries) GetIssue(_ context.Context, id pgtype.UUID) (db.Issue, error) {
	return db.Issue{ID: id, WorkspaceID: util.MustParseUUID(testWorkspaceID), Title: "修复登录", Number: 30}, nil
}

func (f *fakeQueries) GetWorkspace(_ context.Context, id pgtype.UUID) (db.Workspace, error) {
	return db.Workspace{ID: id, Slug: "lumist", IssuePrefix: "LUM"}, nil
}

func (f *fakeQueries) GetIssueStatusEntryByKey(_ context.Context, arg db.GetIssueStatusEntryByKeyParams) (db.IssueStatus, error) {
	if arg.Key == "started_3" {
		return db.IssueStatus{Key: arg.Key, Name: "验证中"}, nil
	}
	return db.IssueStatus{}, pgx.ErrNoRows
}

type fakeSender struct {
	mu    sync.Mutex
	calls []lark.SendUserCardParams
	fail  error
	block chan struct{}
}

func (s *fakeSender) SendUserCard(_ context.Context, p lark.SendUserCardParams) (string, error) {
	if s.block != nil {
		<-s.block
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, p)
	if s.fail != nil {
		return "", s.fail
	}
	return "om_x", nil
}

func (s *fakeSender) sent() []lark.SendUserCardParams {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]lark.SendUserCardParams(nil), s.calls...)
}

func linkedUser() db.User {
	return db.User{
		ID:           util.MustParseUUID(testRecipientID),
		Name:         "honwee",
		FeishuOpenID: pgtype.Text{String: "ou_honwee", Valid: true},
	}
}

func actorUser() db.User {
	return db.User{ID: util.MustParseUUID(testActorID), Name: "张三"}
}

func newTestNotifier(q *fakeQueries, s *fakeSender, window time.Duration) *Notifier {
	return New(q, s, Config{
		Credentials:  lark.InstallationCredentials{AppID: "cli_login"},
		AppURL:       "https://fde.lumistedu.com",
		Window:       window,
		MaxAttempts:  3,
		RetryBackoff: time.Millisecond,
	})
}

func inboxEvent(issueID, notifType, body string, details map[string]string) events.Event {
	raw, _ := json.Marshal(details)
	if details == nil {
		raw = []byte("{}")
	}
	issue := issueID
	actorType := "member"
	actor := testActorID
	return events.Event{
		Type:        protocol.EventInboxNew,
		WorkspaceID: testWorkspaceID,
		Payload: map[string]any{"item": map[string]any{
			"id":             "66666666-6666-6666-6666-666666666666",
			"workspace_id":   testWorkspaceID,
			"recipient_type": "member",
			"recipient_id":   testRecipientID,
			"type":           notifType,
			"issue_id":       &issue,
			"title":          "修复登录",
			"body":           &body,
			"actor_type":     &actorType,
			"actor_id":       &actor,
			"details":        json.RawMessage(raw),
		}},
	}
}

// process runs one event through the worker path synchronously.
func process(n *Notifier, e events.Event) {
	n.handle(e)
	n.accept(context.Background(), <-n.queue)
}

func enabledQueries(extra map[string]string) *fakeQueries {
	prefs := map[string]string{PreferenceKey: "all"}
	for k, v := range extra {
		prefs[k] = v
	}
	return &fakeQueries{prefs: prefs, users: map[string]db.User{testRecipientID: linkedUser(), testActorID: actorUser()}}
}

func TestNotifier_DisabledByDefault(t *testing.T) {
	for name, q := range map[string]*fakeQueries{
		"no preference row": {users: map[string]db.User{testRecipientID: linkedUser()}},
		"other keys only":   {prefs: map[string]string{"comments": "all"}, users: map[string]db.User{testRecipientID: linkedUser()}},
		"explicitly off":    {prefs: map[string]string{PreferenceKey: "muted"}, users: map[string]db.User{testRecipientID: linkedUser()}},
	} {
		t.Run(name, func(t *testing.T) {
			s := &fakeSender{}
			n := newTestNotifier(q, s, 20*time.Millisecond)
			process(n, inboxEvent(testIssueID, "new_comment", "hello", nil))
			n.Wait()
			if got := len(s.sent()); got != 0 {
				t.Fatalf("sent %d messages with the toggle off", got)
			}
		})
	}
}

func TestNotifier_MutedGroupIsNotPushed(t *testing.T) {
	s := &fakeSender{}
	n := newTestNotifier(enabledQueries(map[string]string{"comments": "muted"}), s, 20*time.Millisecond)
	process(n, inboxEvent(testIssueID, "new_comment", "hello", nil))
	n.Wait()
	if got := len(s.sent()); got != 0 {
		t.Fatalf("sent %d messages for a muted group", got)
	}

	process(n, inboxEvent(testIssueID, "status_changed", "", map[string]string{"from": "todo", "to": "done"}))
	n.Wait()
	if got := len(s.sent()); got != 1 {
		t.Fatalf("unmuted group: sent %d, want 1", got)
	}
}

func TestNotifier_SkipsRecipientWithoutFeishuIdentity(t *testing.T) {
	q := enabledQueries(nil)
	q.users[testRecipientID] = db.User{ID: util.MustParseUUID(testRecipientID), Name: "no feishu"}
	s := &fakeSender{}
	n := newTestNotifier(q, s, 20*time.Millisecond)
	process(n, inboxEvent(testIssueID, "new_comment", "hello", nil))
	n.Wait()
	if got := len(s.sent()); got != 0 {
		t.Fatalf("sent %d messages to an unlinked user", got)
	}
}

func TestNotifier_FallsBackToUnionID(t *testing.T) {
	q := enabledQueries(nil)
	q.users[testRecipientID] = db.User{ID: util.MustParseUUID(testRecipientID), FeishuUnionID: pgtype.Text{String: "on_u", Valid: true}}
	s := &fakeSender{}
	n := newTestNotifier(q, s, 20*time.Millisecond)
	process(n, inboxEvent(testIssueID, "new_comment", "hello", nil))
	n.Wait()
	sent := s.sent()
	if len(sent) != 1 || sent[0].ReceiveIDType != lark.ReceiveIDTypeUnionID || sent[0].ReceiveID != "on_u" {
		t.Fatalf("unexpected sends: %+v", sent)
	}
}

func TestNotifier_SendsCardWithIssueEventExcerptAndLink(t *testing.T) {
	s := &fakeSender{}
	n := newTestNotifier(enabledQueries(nil), s, 20*time.Millisecond)
	long := strings.Repeat("很", 250)
	process(n, inboxEvent(testIssueID, "new_comment", "[@honwee](mention://member/x) "+long, nil))
	n.Wait()
	sent := s.sent()
	if len(sent) != 1 {
		t.Fatalf("sent %d, want 1", len(sent))
	}
	if sent[0].ReceiveIDType != lark.ReceiveIDTypeOpenID || sent[0].ReceiveID != "ou_honwee" || sent[0].Credentials.AppID != "cli_login" {
		t.Fatalf("wrong addressing: %+v", sent[0])
	}
	card := sent[0].CardJSON
	for _, want := range []string{"LUM-30 修复登录", "张三 评论了", "@honwee 很", "https://fde.lumistedu.com/lumist/issues/LUM-30"} {
		if !strings.Contains(card, want) {
			t.Errorf("card missing %q: %s", want, card)
		}
	}
	if strings.Contains(card, "mention://") {
		t.Errorf("card leaks mention markup: %s", card)
	}
	if strings.Contains(card, strings.Repeat("很", 201)) {
		t.Errorf("excerpt not truncated to ~200 chars")
	}
}

func TestNotifier_StatusLabels(t *testing.T) {
	s := &fakeSender{}
	n := newTestNotifier(enabledQueries(nil), s, 20*time.Millisecond)
	process(n, inboxEvent(testIssueID, "status_changed", "", map[string]string{"to": "in_review"}))
	process(n, inboxEvent(otherIssueID, "status_changed", "", map[string]string{"to": "started_3"}))
	n.Wait()
	cards := ""
	for _, c := range s.sent() {
		cards += c.CardJSON
	}
	for _, want := range []string{"把状态改为「审核中」", "把状态改为「验证中」"} {
		if !strings.Contains(cards, want) {
			t.Errorf("cards missing %q: %s", want, cards)
		}
	}
}

func TestNotifier_MergesBurstOnOneIssue(t *testing.T) {
	s := &fakeSender{}
	n := newTestNotifier(enabledQueries(nil), s, 100*time.Millisecond)
	process(n, inboxEvent(testIssueID, "new_comment", "第一条", nil))
	process(n, inboxEvent(testIssueID, "new_comment", "第二条", nil))
	process(n, inboxEvent(testIssueID, "status_changed", "", map[string]string{"to": "done"}))
	process(n, inboxEvent(otherIssueID, "new_comment", "另一个 issue", nil))
	n.Wait()

	sent := s.sent()
	if len(sent) != 3 {
		t.Fatalf("sent %d messages, want 3 (first, merged rest, other issue)", len(sent))
	}
	var merged string
	for _, c := range sent {
		if strings.Contains(c.CardJSON, "1 分钟内有 2 条更新") {
			merged = c.CardJSON
		}
	}
	if merged == "" {
		t.Fatalf("no merged message among %d sends", len(sent))
	}
	if !strings.Contains(merged, "第二条") || !strings.Contains(merged, "已完成") || strings.Contains(merged, "第一条") {
		t.Errorf("merged message has wrong content: %s", merged)
	}
}

func TestNotifier_SendFailureRetriesThenGivesUp(t *testing.T) {
	s := &fakeSender{fail: errors.New("connection reset")}
	n := newTestNotifier(enabledQueries(nil), s, 20*time.Millisecond)
	process(n, inboxEvent(testIssueID, "new_comment", "hello", nil))
	n.Wait()
	if got := len(s.sent()); got != 3 {
		t.Fatalf("attempts = %d, want 3", got)
	}
}

func TestNotifier_BusinessErrorIsNotRetried(t *testing.T) {
	s := &fakeSender{fail: &lark.APIError{Op: "send user card", Code: 230013, Msg: "no availability"}}
	n := newTestNotifier(enabledQueries(nil), s, 20*time.Millisecond)
	process(n, inboxEvent(testIssueID, "new_comment", "hello", nil))
	n.Wait()
	if got := len(s.sent()); got != 1 {
		t.Fatalf("attempts = %d, want 1", got)
	}
}

// The inbox row is written before inbox:new is published, so the push must
// never hold up or fail the publisher: a stuck sender and a full queue both
// leave Publish returning at once.
func TestNotifier_NeverBlocksThePublisher(t *testing.T) {
	block := make(chan struct{})
	s := &fakeSender{block: block}
	n := New(enabledQueries(nil), s, Config{Window: time.Hour, QueueSize: 1, MaxAttempts: 1})
	bus := events.New()
	n.Register(bus)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go n.Run(ctx)

	done := make(chan struct{})
	go func() {
		for i := 0; i < 50; i++ {
			bus.Publish(inboxEvent(testIssueID, "new_comment", "hello", nil))
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Publish blocked behind the Feishu push")
	}
	close(block)
}

func TestNotifier_IgnoresAgentRecipientsAndIssuelessItems(t *testing.T) {
	n := newTestNotifier(enabledQueries(nil), &fakeSender{}, time.Millisecond)
	agentItem := inboxEvent(testIssueID, "new_comment", "x", nil)
	agentItem.Payload.(map[string]any)["item"].(map[string]any)["recipient_type"] = "agent"
	n.handle(agentItem)
	issueless := inboxEvent(testIssueID, "autopilot_paused", "x", nil)
	issueless.Payload.(map[string]any)["item"].(map[string]any)["issue_id"] = (*string)(nil)
	n.handle(issueless)
	if len(n.queue) != 0 {
		t.Fatalf("queued %d events, want 0", len(n.queue))
	}
}
