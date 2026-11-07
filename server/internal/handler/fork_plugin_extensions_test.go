package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/feishunotify"
	"github.com/multica-ai/multica/server/internal/integrations/lark"
	"github.com/multica-ai/multica/server/internal/util/secretbox"
	"github.com/multica-ai/multica/server/pkg/plugincontract"
)

// Fork extension points (FORK.md): workspace pages and Feishu card buttons.
// Every test here runs against the real database.

const forkPluginManifest = `{
  "manifest_version": 1,
  "key": "com.example.review",
  "name": "Review",
  "version": "1.0.0",
  "author": { "name": "example" },
  "scopes": ["issues:read", "issues:write", "comments:write", "net:HOOK_HOST"],
  "contributes": {
    "surfaces": [
      { "key": "board", "type": "workspace_page", "name": "Board", "entry": "ui/main.js" },
      { "key": "panel", "type": "issue_panel", "name": "Panel", "entry": "ui/main.js" }
    ],
    "hooks": [{
      "key": "decide",
      "name": "Decide",
      "description": "Records a decision made from a notification card.",
      "triggers": ["card_action"],
      "transport": { "type": "http", "url": "HOOK_URL/hooks/decide" },
      "timeout_ms": 5000
    }],
    "card_buttons": [{
      "key": "approval",
      "hook": "decide",
      "match": { "title_prefixes": ["[审批]"] },
      "buttons": [
        { "key": "approve", "label": "同意", "style": "primary" },
        { "key": "revise", "label": "修改", "input": { "placeholder": "修改意见", "required": true } },
        { "key": "reject", "label": "不要", "style": "danger" }
      ]
    }]
  }
}`

type forkHookEndpoint struct {
	server *httptest.Server
	calls  atomic.Int32
	delay  atomic.Int64
	reply  atomic.Value // string
	last   atomic.Value // []byte
}

func newForkHookEndpoint(t *testing.T) *forkHookEndpoint {
	t.Helper()
	endpoint := &forkHookEndpoint{}
	endpoint.reply.Store(`{}`)
	endpoint.server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		endpoint.calls.Add(1)
		body, _ := io.ReadAll(r.Body)
		endpoint.last.Store(body)
		if delay := time.Duration(endpoint.delay.Load()); delay > 0 {
			select {
			case <-time.After(delay):
			case <-r.Context().Done():
				return
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(endpoint.reply.Load().(string)))
	}))
	t.Cleanup(endpoint.server.Close)
	return endpoint
}

func (e *forkHookEndpoint) host() string {
	parsed, _ := url.Parse(e.server.URL)
	return parsed.Hostname()
}

// installForkPlugin publishes and installs forkPluginManifest with this
// host's real capabilities, pointing its hook at endpoint.
func installForkPlugin(t *testing.T, endpoint *forkHookEndpoint, scopes []string) string {
	t.Helper()
	withPluginsV1Flag(t, testHandler, true)
	cleanupPluginInstallations(t)
	cleanupForkPluginRows(t)

	manifest := strings.NewReplacer("HOOK_URL", endpoint.server.URL, "HOOK_HOST", endpoint.host()).Replace(forkPluginManifest)
	if scopes != nil {
		encoded, _ := json.Marshal(scopes)
		manifest = strings.Replace(manifest,
			`"scopes": ["issues:read", "issues:write", "comments:write", "net:`+endpoint.host()+`"]`,
			`"scopes": `+string(encoded), 1)
	}
	root := t.TempDir()
	writeLocalPluginManifest(t, root, manifest)

	service := testHandler.PluginService
	previous := struct {
		dir     string
		host    plugincontract.Capabilities
		secrets *secretbox.Box
		origins []string
		client  *http.Client
		key     []byte
	}{service.LocalDir, service.Host, service.Secrets, service.DevOrigins, service.HookClient, service.DeploymentKey}
	previousCallbacks := service.Callbacks
	box, err := secretbox.New(bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatalf("secretbox.New: %v", err)
	}
	service.LocalDir = root
	service.Host = plugincontract.HostCapabilities()
	service.Secrets = box
	service.DevOrigins = []string{endpoint.server.URL}
	service.HookClient = endpoint.server.Client()
	service.DeploymentKey = bytes.Repeat([]byte{5}, 32)
	t.Cleanup(func() {
		service.LocalDir, service.Host, service.Secrets = previous.dir, previous.host, previous.secrets
		service.DevOrigins, service.HookClient, service.DeploymentKey = previous.origins, previous.client, previous.key
		service.Callbacks = previousCallbacks
	})

	versionID := publishLocalPlugin(t, "hello")
	granted := scopes
	if granted == nil {
		granted = []string{"issues:read", "issues:write", "comments:write", "net:" + endpoint.host()}
	}
	body, _ := json.Marshal(map[string]any{"version_id": versionID, "granted_scopes": granted})
	recorder := httptest.NewRecorder()
	testHandler.InstallPlugin(recorder, pluginHandlerRequest(http.MethodPost, "/plugins", body, map[string]string{"id": testWorkspaceID}))
	if recorder.Code != http.StatusCreated {
		t.Fatalf("install status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var installed struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(recorder.Body.Bytes(), &installed)
	return installed.ID
}

// createForkTestIssue creates an issue and deletes it after the test, so the
// shared workspace does not grow past other suites' list limits.
func createForkTestIssue(t *testing.T, title, status, priority string) string {
	t.Helper()
	id := createTestIssue(t, title, status, priority)
	t.Cleanup(func() {
		ctx := context.Background()
		testPool.Exec(ctx, `DELETE FROM comment WHERE issue_id = $1`, id)
		testPool.Exec(ctx, `DELETE FROM issue WHERE id = $1`, id)
	})
	return id
}

func cleanupForkPluginRows(t *testing.T) {
	t.Helper()
	remove := func() {
		ctx := context.Background()
		testPool.Exec(ctx, `DELETE FROM plugin_card_action WHERE workspace_id = $1`, testWorkspaceID)
		testPool.Exec(ctx, `DELETE FROM plugin_batch_action WHERE workspace_id = $1`, testWorkspaceID)
	}
	remove()
	t.Cleanup(remove)
}

// setPluginExtensions writes the workspace switches and restores the settings
// after the test.
func setPluginExtensions(t *testing.T, pages, cards bool) {
	t.Helper()
	ctx := context.Background()
	var original []byte
	if err := testPool.QueryRow(ctx, `SELECT settings FROM workspace WHERE id = $1`, testWorkspaceID).Scan(&original); err != nil {
		t.Fatalf("read settings: %v", err)
	}
	switches, _ := json.Marshal(map[string]bool{"workspace_pages": pages, "card_buttons": cards})
	if _, err := testPool.Exec(ctx,
		`UPDATE workspace SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{plugin_extensions}', $2::jsonb) WHERE id = $1`,
		testWorkspaceID, string(switches)); err != nil {
		t.Fatalf("write settings: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `UPDATE workspace SET settings = $2 WHERE id = $1`, testWorkspaceID, original)
	})
}

func decodeProblemCode(t *testing.T, recorder *httptest.ResponseRecorder) string {
	t.Helper()
	var problem struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(recorder.Body.Bytes(), &problem)
	return problem.Code
}

func TestParsePluginExtensionsNeedsExplicitTrue(t *testing.T) {
	for raw, want := range map[string]PluginExtensions{
		``:   {},
		`{}`: {},
		`{"plugin_extensions":{"workspace_pages":"true","card_buttons":1}}`:   {},
		`{"plugin_extensions":{"workspace_pages":true}}`:                      {WorkspacePages: true},
		`{"plugin_extensions":{"workspace_pages":false,"card_buttons":true}}`: {CardButtons: true},
		`{"plugin_extensions":[true]}`:                                        {},
	} {
		if got := ParsePluginExtensions([]byte(raw)); got != want {
			t.Errorf("ParsePluginExtensions(%s) = %+v, want %+v", raw, got, want)
		}
	}
}

func TestPluginPageEndpointsRefusedWhileSwitchedOff(t *testing.T) {
	endpoint := newForkHookEndpoint(t)
	installationID := installForkPlugin(t, endpoint, nil)
	setPluginExtensions(t, false, false)
	issueID := createForkTestIssue(t, "page switch off", "todo", "none")

	list := httptest.NewRecorder()
	testHandler.ListPluginPageIssues(list, pluginActionRequest(http.MethodGet, "/issues", installationID, nil, nil))
	if list.Code != http.StatusForbidden || decodeProblemCode(t, list) != "plugin_extension_disabled" {
		t.Fatalf("list while off: status=%d body=%s", list.Code, list.Body.String())
	}
	batch := httptest.NewRecorder()
	testHandler.BatchCommentPluginPageIssues(batch, pluginActionRequest(http.MethodPost, "/issue-batches/comments", installationID,
		map[string]any{"issue_ids": []string{issueID}, "content": "must not post"}, nil))
	if batch.Code != http.StatusForbidden {
		t.Fatalf("batch while off: status=%d body=%s", batch.Code, batch.Body.String())
	}
	var comments int
	testPool.QueryRow(context.Background(), `SELECT count(*) FROM comment WHERE issue_id = $1`, issueID).Scan(&comments)
	if comments != 0 {
		t.Fatalf("a refused batch created %d comments", comments)
	}
}

func TestPluginPageListIssuesFiltersAndPages(t *testing.T) {
	endpoint := newForkHookEndpoint(t)
	installationID := installForkPlugin(t, endpoint, nil)
	setPluginExtensions(t, true, false)
	marker := "page-list-" + uuid.NewString()[:8]
	for i := 0; i < 3; i++ {
		createForkTestIssue(t, marker+"-"+strconv.Itoa(i), "in_review", "none")
	}

	type page struct {
		Issues     []pluginPageIssue `json:"issues"`
		NextOffset *int              `json:"next_offset"`
	}
	fetch := func(query string) page {
		t.Helper()
		recorder := httptest.NewRecorder()
		testHandler.ListPluginPageIssues(recorder, pluginActionRequest(http.MethodGet, "/issues?"+query, installationID, nil, nil))
		if recorder.Code != http.StatusOK {
			t.Fatalf("list %s: status=%d body=%s", query, recorder.Code, recorder.Body.String())
		}
		var out page
		_ = json.Unmarshal(recorder.Body.Bytes(), &out)
		return out
	}
	seen := map[string]bool{}
	next := 0
	for pages := 0; pages < 100; pages++ {
		got := fetch("status=in_review&limit=2&offset=" + strconv.Itoa(next))
		for _, issue := range got.Issues {
			if issue.Status != "in_review" || issue.Identifier == "" {
				t.Fatalf("filter leaked %+v", issue)
			}
			if strings.HasPrefix(issue.Title, marker) {
				seen[issue.ID] = true
			}
		}
		if got.NextOffset == nil {
			break
		}
		next = *got.NextOffset
	}
	if len(seen) != 3 {
		t.Fatalf("paged through %d of the 3 marked issues", len(seen))
	}

	bad := httptest.NewRecorder()
	testHandler.ListPluginPageIssues(bad, pluginActionRequest(http.MethodGet, "/issues?limit=500", installationID, nil, nil))
	if bad.Code != http.StatusBadRequest {
		t.Fatalf("limit=500 status=%d", bad.Code)
	}
}

func TestPluginPageBatchCommentChecksEachItem(t *testing.T) {
	endpoint := newForkHookEndpoint(t)
	installationID := installForkPlugin(t, endpoint, nil)
	setPluginExtensions(t, true, false)
	issueID := createForkTestIssue(t, "batch comment", "todo", "none")
	missing := uuid.NewString()

	recorder := httptest.NewRecorder()
	testHandler.BatchCommentPluginPageIssues(recorder, pluginActionRequest(http.MethodPost, "/issue-batches/comments", installationID,
		map[string]any{"issue_ids": []string{issueID, missing, "NOPE-99999"}, "content": "批量评论"}, nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("batch status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var out pluginBatchResponse
	_ = json.Unmarshal(recorder.Body.Bytes(), &out)
	if out.Succeeded != 1 || out.Failed != 2 || out.Results[0].Status != pluginItemOK ||
		out.Results[1].Status != pluginItemNotFound || out.Results[2].Status != pluginItemNotFound {
		t.Fatalf("results = %+v", out)
	}

	var authorType, authorID, via string
	err := testPool.QueryRow(context.Background(),
		`SELECT author_type, author_id::text, via_plugin_id::text FROM comment WHERE issue_id = $1`, issueID).Scan(&authorType, &authorID, &via)
	if err != nil || authorType != "member" || authorID != testUserID || via != installationID {
		t.Fatalf("comment attribution type=%s author=%s via=%s err=%v", authorType, authorID, via, err)
	}
	var audited int
	testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM plugin_batch_action WHERE via_plugin_id = $1 AND user_id = $2 AND action = 'comment'`,
		installationID, testUserID).Scan(&audited)
	if audited != 3 {
		t.Fatalf("audited %d items, want every item recorded", audited)
	}
}

func TestPluginPageBatchRequiresTheScopeAndAMember(t *testing.T) {
	endpoint := newForkHookEndpoint(t)
	installationID := installForkPlugin(t, endpoint, []string{"issues:read", "net:" + endpoint.host()})
	setPluginExtensions(t, true, false)
	issueID := createForkTestIssue(t, "batch scope", "todo", "none")

	recorder := httptest.NewRecorder()
	testHandler.BatchSetStatusPluginPageIssues(recorder, pluginActionRequest(http.MethodPost, "/issue-batches/status", installationID,
		map[string]any{"issue_ids": []string{issueID}, "status": "done"}, nil))
	if recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), "issues:write") {
		t.Fatalf("ungranted batch status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	stranger := pluginActionRequest(http.MethodPost, "/issue-batches/comments", installationID,
		map[string]any{"issue_ids": []string{issueID}, "content": "x"}, nil)
	stranger.Header.Set("X-User-ID", uuid.NewString())
	recorder = httptest.NewRecorder()
	testHandler.BatchCommentPluginPageIssues(recorder, stranger)
	if recorder.Code == http.StatusOK {
		t.Fatalf("a non-member ran a batch: %s", recorder.Body.String())
	}
}

func TestPluginPageBatchSetStatusGoesThroughIssueRules(t *testing.T) {
	endpoint := newForkHookEndpoint(t)
	installationID := installForkPlugin(t, endpoint, nil)
	setPluginExtensions(t, true, false)
	first := createForkTestIssue(t, "batch status 1", "todo", "none")
	second := createForkTestIssue(t, "batch status 2", "todo", "none")

	recorder := httptest.NewRecorder()
	testHandler.BatchSetStatusPluginPageIssues(recorder, pluginActionRequest(http.MethodPost, "/issue-batches/status", installationID,
		map[string]any{"issue_ids": []string{first, second}, "status": "in_review"}, nil))
	var out pluginBatchResponse
	_ = json.Unmarshal(recorder.Body.Bytes(), &out)
	if recorder.Code != http.StatusOK || out.Succeeded != 2 {
		t.Fatalf("batch status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	for _, id := range []string{first, second} {
		var status string
		testPool.QueryRow(context.Background(), `SELECT status FROM issue WHERE id = $1`, id).Scan(&status)
		if status != "in_review" {
			t.Fatalf("issue %s status = %s", id, status)
		}
	}

	recorder = httptest.NewRecorder()
	testHandler.BatchSetStatusPluginPageIssues(recorder, pluginActionRequest(http.MethodPost, "/issue-batches/status", installationID,
		map[string]any{"issue_ids": []string{first}, "status": "no_such_status"}, nil))
	_ = json.Unmarshal(recorder.Body.Bytes(), &out)
	if out.Failed != 1 || out.Results[0].Status != pluginItemInvalid {
		t.Fatalf("unknown status results = %+v", out)
	}
	var audited int
	testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM plugin_batch_action WHERE via_plugin_id = $1 AND action = 'set_status'`, installationID).Scan(&audited)
	if audited != 3 {
		t.Fatalf("audited %d status items, want 3", audited)
	}
}

func TestPluginWorkspacePageLaunchFollowsSwitchAndKeepsCSP(t *testing.T) {
	endpoint := newForkHookEndpoint(t)
	installationID := installForkPlugin(t, endpoint, nil)

	box, err := NewPluginSurfaceTokenBox(bytes.Repeat([]byte{9}, 32))
	if err != nil {
		t.Fatalf("token box: %v", err)
	}
	previousOrigin, previousTokens := testHandler.cfg.PluginSurfaceOrigin, testHandler.PluginSurfaceTokens
	testHandler.cfg.PluginSurfaceOrigin = "https://plugin-content.example.test"
	testHandler.PluginSurfaceTokens = box
	t.Cleanup(func() {
		testHandler.cfg.PluginSurfaceOrigin, testHandler.PluginSurfaceTokens = previousOrigin, previousTokens
	})

	launch := func(surfaceKey string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		testHandler.GetPluginSurfaceLaunch(recorder, pluginHandlerRequest(http.MethodGet, "/launch", nil,
			map[string]string{"id": testWorkspaceID, "installationId": installationID, "surfaceKey": surfaceKey}))
		return recorder
	}

	setPluginExtensions(t, false, false)
	if off := launch("board"); off.Code != http.StatusForbidden || !strings.Contains(off.Body.String(), "plugin_extension_disabled") {
		t.Fatalf("page launch while off: status=%d body=%s", off.Code, off.Body.String())
	}
	if panel := launch("panel"); panel.Code != http.StatusOK {
		t.Fatalf("the switch must not touch issue panels: status=%d body=%s", panel.Code, panel.Body.String())
	}

	setPluginExtensions(t, true, false)
	on := launch("board")
	if on.Code != http.StatusOK {
		t.Fatalf("page launch while on: status=%d body=%s", on.Code, on.Body.String())
	}
	var launched pluginSurfaceLaunch
	_ = json.Unmarshal(on.Body.Bytes(), &launched)
	parsed, _ := url.Parse(launched.URL)
	request := httptest.NewRequest(http.MethodGet, parsed.Path, nil)
	request.Host = parsed.Host
	routeContext := chi.NewRouteContext()
	routeContext.URLParams.Add("token", strings.TrimPrefix(parsed.Path, "/plugin-surfaces/"))
	request = request.WithContext(context.WithValue(request.Context(), chi.RouteCtxKey, routeContext))
	served := httptest.NewRecorder()
	testHandler.ServePluginSurface(served, request)
	if served.Code != http.StatusOK {
		t.Fatalf("serve page: status=%d body=%s", served.Code, served.Body.String())
	}
	csp := served.Header().Get("Content-Security-Policy")
	if !strings.Contains(csp, "connect-src https://"+endpoint.host()) || !strings.Contains(csp, "default-src 'none'") {
		t.Fatalf("page CSP is not derived from the granted net: scope: %s", csp)
	}
}

// --- Card buttons ---

func cardActions(t *testing.T) *PluginCardActions {
	t.Helper()
	return testHandler.PluginCardActions()
}

func agentBotInstallation() lark.Installation {
	return lark.Installation{ID: pgtype.UUID{Bytes: uuid.New(), Valid: true}, WorkspaceID: parseUUID(testWorkspaceID)}
}

func bindFeishuUser(t *testing.T, inst lark.Installation, userID, openID string) {
	t.Helper()
	_, err := testPool.Exec(context.Background(), `
		INSERT INTO channel_user_binding (workspace_id, multica_user_id, installation_id, channel_type, channel_user_id)
		VALUES ($1, $2, $3, 'feishu', $4)`, testWorkspaceID, userID, uuidToString(inst.ID), openID)
	if err != nil {
		t.Fatalf("bind feishu user: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM channel_user_binding WHERE installation_id = $1`, uuidToString(inst.ID))
	})
}

func clickEvent(token, messageID, openID, input string) lark.CardActionEvent {
	event := lark.CardActionEvent{
		OperatorOpenID: openID,
		MessageID:      messageID,
		Value:          map[string]any{feishunotify.CardActionValueKey: token},
	}
	if input != "" {
		event.FormValue = map[string]any{feishunotify.CardActionInputName: input}
	}
	return event
}

func buttonToken(t *testing.T, blocks []feishunotify.CardButtonBlock, key string) string {
	t.Helper()
	for _, block := range blocks {
		for _, button := range block.Buttons {
			if button.Key == key {
				return button.Token
			}
		}
	}
	t.Fatalf("no %q button in %+v", key, blocks)
	return ""
}

func TestPluginCardButtonsFollowSwitchAndRules(t *testing.T) {
	endpoint := newForkHookEndpoint(t)
	installationID := installForkPlugin(t, endpoint, nil)
	matching := createForkTestIssue(t, "[审批] 调课", "todo", "none")
	other := createForkTestIssue(t, "普通任务", "todo", "none")
	actions := cardActions(t)

	setPluginExtensions(t, false, false)
	if blocks := actions.CardButtons(context.Background(), testWorkspaceID, matching, testUserID); blocks != nil {
		t.Fatalf("switch off rendered %+v", blocks)
	}

	setPluginExtensions(t, false, true)
	blocks := actions.CardButtons(context.Background(), testWorkspaceID, matching, testUserID)
	if len(blocks) != 1 || len(blocks[0].Buttons) != 3 || blocks[0].Input == nil {
		t.Fatalf("matching issue blocks = %+v", blocks)
	}
	if blocks := actions.CardButtons(context.Background(), testWorkspaceID, other, testUserID); blocks != nil {
		t.Fatalf("non-matching issue rendered %+v", blocks)
	}

	withPluginsV1Flag(t, testHandler, false)
	if blocks := actions.CardButtons(context.Background(), testWorkspaceID, matching, testUserID); blocks != nil {
		t.Fatalf("Plugins flag off rendered %+v", blocks)
	}
	withPluginsV1Flag(t, testHandler, true)

	testPool.Exec(context.Background(), `UPDATE plugin_installation SET enabled = false WHERE id = $1`, installationID)
	if blocks := actions.CardButtons(context.Background(), testWorkspaceID, matching, testUserID); blocks != nil {
		t.Fatalf("disabled plugin rendered %+v", blocks)
	}
}

func TestPluginCardActionRunsOnceAsTheClicker(t *testing.T) {
	endpoint := newForkHookEndpoint(t)
	endpoint.reply.Store(`{"effects":[{"type":"comment","content":"同意执行"},{"type":"set_status","status":"in_review"}],"status_text":"已同意"}`)
	installationID := installForkPlugin(t, endpoint, nil)
	setPluginExtensions(t, false, true)
	issueID := createForkTestIssue(t, "[审批] 请假", "todo", "none")
	inst := agentBotInstallation()
	bindFeishuUser(t, inst, testUserID, "ou_member")
	actions := cardActions(t)
	token := buttonToken(t, actions.CardButtons(context.Background(), testWorkspaceID, issueID, testUserID), "approve")

	reply := actions.HandleCardAction(context.Background(), inst, clickEvent(token, "om_once", "ou_member", ""))
	if reply == nil || reply.Toast == nil || reply.Toast.Type != lark.CardToastSuccess || reply.Toast.Content != "已同意" {
		t.Fatalf("reply = %+v", reply)
	}
	if !strings.Contains(string(reply.Card), "已同意 · ") || strings.Contains(string(reply.Card), `"button"`) {
		t.Fatalf("decision card = %s", reply.Card)
	}

	var sent map[string]any
	_ = json.Unmarshal(endpoint.last.Load().([]byte), &sent)
	actor, _ := sent["actor"].(map[string]any)
	if sent["trigger"] != "card_action" || sent["issue_id"] != issueID || actor["type"] != "member" || actor["id"] != testUserID {
		t.Fatalf("hook request = %v", sent)
	}

	ctx := context.Background()
	var authorID, via, status string
	testPool.QueryRow(ctx, `SELECT author_id::text, via_plugin_id::text FROM comment WHERE issue_id = $1`, issueID).Scan(&authorID, &via)
	testPool.QueryRow(ctx, `SELECT status FROM issue WHERE id = $1`, issueID).Scan(&status)
	if authorID != testUserID || via != installationID || status != "in_review" {
		t.Fatalf("effects: author=%s via=%s status=%s", authorID, via, status)
	}

	again := actions.HandleCardAction(ctx, inst, clickEvent(token, "om_once", "ou_member", ""))
	if again == nil || again.Toast == nil || !strings.Contains(again.Toast.Content, "已经处理过") {
		t.Fatalf("second click reply = %+v", again)
	}
	if calls := endpoint.calls.Load(); calls != 1 {
		t.Fatalf("hook called %d times for one card", calls)
	}
	var comments, invocations int
	testPool.QueryRow(ctx, `SELECT count(*) FROM comment WHERE issue_id = $1`, issueID).Scan(&comments)
	testPool.QueryRow(ctx, `SELECT count(*) FROM plugin_invocation WHERE installation_id = $1 AND trigger = 'card_action'`, installationID).Scan(&invocations)
	if comments != 1 || invocations != 1 {
		t.Fatalf("comments=%d invocations=%d, want one decision", comments, invocations)
	}
}

func TestPluginCardActionRefusesUnknownClickerAndUnauthorizedAccess(t *testing.T) {
	endpoint := newForkHookEndpoint(t)
	installForkPlugin(t, endpoint, nil)
	setPluginExtensions(t, false, true)
	issueID := createForkTestIssue(t, "[审批] 采购", "todo", "none")
	inst := agentBotInstallation()
	actions := cardActions(t)
	token := buttonToken(t, actions.CardButtons(context.Background(), testWorkspaceID, issueID, testUserID), "approve")

	if reply := actions.HandleCardAction(context.Background(), inst, clickEvent(token, "om_unknown", "ou_nobody", "")); reply == nil ||
		reply.Toast.Type != lark.CardToastError || !strings.Contains(reply.Toast.Content, "无法识别") {
		t.Fatalf("unknown clicker reply = %+v", reply)
	}

	// A real user who is not a member of the workspace.
	var outsider string
	if err := testPool.QueryRow(context.Background(),
		`INSERT INTO "user" (name, email) VALUES ('Outsider', $1) RETURNING id::text`, "outsider-"+uuid.NewString()+"@example.test").Scan(&outsider); err != nil {
		t.Fatalf("create outsider: %v", err)
	}
	t.Cleanup(func() { testPool.Exec(context.Background(), `DELETE FROM "user" WHERE id = $1`, outsider) })
	bindFeishuUser(t, inst, outsider, "ou_outsider")
	if reply := actions.HandleCardAction(context.Background(), inst, clickEvent(token, "om_outsider", "ou_outsider", "")); reply == nil ||
		!strings.Contains(reply.Toast.Content, "不是该工作区的成员") {
		t.Fatalf("outsider reply = %+v", reply)
	}

	// The same click through another workspace's bot.
	foreign := lark.Installation{ID: inst.ID, WorkspaceID: pgtype.UUID{Bytes: uuid.New(), Valid: true}}
	if reply := actions.HandleCardAction(context.Background(), foreign, clickEvent(token, "om_foreign", "ou_outsider", "")); reply == nil ||
		!strings.Contains(reply.Toast.Content, "不匹配") {
		t.Fatalf("foreign bot reply = %+v", reply)
	}

	tampered := strings.Replace(token, token[len(token)-4:], "AAAA", 1)
	if reply := actions.HandleCardAction(context.Background(), inst, clickEvent(tampered, "om_tampered", "ou_outsider", "")); reply == nil ||
		!strings.Contains(reply.Toast.Content, "已失效") {
		t.Fatalf("tampered token reply = %+v", reply)
	}

	if reply := actions.HandleCardAction(context.Background(), inst, lark.CardActionEvent{MessageID: "om_x", OperatorOpenID: "ou_x"}); reply != nil {
		t.Fatalf("a card without a plugin token must be left alone, got %+v", reply)
	}
	if calls := endpoint.calls.Load(); calls != 0 {
		t.Fatalf("hook called %d times for refused clicks", calls)
	}
}

func TestPluginCardActionTimeoutFailsAndAllowsRetry(t *testing.T) {
	endpoint := newForkHookEndpoint(t)
	endpoint.reply.Store(`{"status_text":"已记录"}`)
	endpoint.delay.Store(int64(3 * time.Second))
	installForkPlugin(t, endpoint, nil)
	setPluginExtensions(t, false, true)
	issueID := createForkTestIssue(t, "[审批] 超时", "todo", "none")
	inst := agentBotInstallation()
	bindFeishuUser(t, inst, testUserID, "ou_member_timeout")
	actions := cardActions(t)
	token := buttonToken(t, actions.CardButtons(context.Background(), testWorkspaceID, issueID, testUserID), "approve")

	started := time.Now()
	reply := actions.HandleCardAction(context.Background(), inst, clickEvent(token, "om_timeout", "ou_member_timeout", ""))
	if elapsed := time.Since(started); elapsed > lark.CardActionTimeout {
		t.Fatalf("a slow hook held the callback for %s", elapsed)
	}
	if reply == nil || reply.Toast.Type != lark.CardToastError || !strings.Contains(reply.Toast.Content, "超时") {
		t.Fatalf("timeout reply = %+v", reply)
	}
	var status string
	testPool.QueryRow(context.Background(), `SELECT status FROM plugin_card_action WHERE message_id = 'om_timeout'`).Scan(&status)
	if status != "failed" {
		t.Fatalf("timed-out claim status = %q", status)
	}

	endpoint.delay.Store(0)
	retry := actions.HandleCardAction(context.Background(), inst, clickEvent(token, "om_timeout", "ou_member_timeout", ""))
	if retry == nil || retry.Toast.Type != lark.CardToastSuccess {
		t.Fatalf("retry after timeout = %+v", retry)
	}
}

func TestPluginCardActionRequiresInputForInputButtons(t *testing.T) {
	endpoint := newForkHookEndpoint(t)
	installForkPlugin(t, endpoint, nil)
	setPluginExtensions(t, false, true)
	issueID := createForkTestIssue(t, "[审批] 修改", "todo", "none")
	inst := agentBotInstallation()
	bindFeishuUser(t, inst, testUserID, "ou_member_input")
	actions := cardActions(t)
	token := buttonToken(t, actions.CardButtons(context.Background(), testWorkspaceID, issueID, testUserID), "revise")

	if reply := actions.HandleCardAction(context.Background(), inst, clickEvent(token, "om_input", "ou_member_input", "")); reply == nil ||
		!strings.Contains(reply.Toast.Content, "请先填写") {
		t.Fatalf("empty input reply = %+v", reply)
	}
	if endpoint.calls.Load() != 0 {
		t.Fatal("hook called without the required input")
	}
	reply := actions.HandleCardAction(context.Background(), inst, clickEvent(token, "om_input", "ou_member_input", "改到周五"))
	if reply == nil || reply.Toast.Type != lark.CardToastSuccess || !strings.Contains(string(reply.Card), "改到周五") {
		t.Fatalf("input reply = %+v", reply)
	}
	var sent struct {
		Input map[string]any `json:"input"`
	}
	_ = json.Unmarshal(endpoint.last.Load().([]byte), &sent)
	if sent.Input["input"] != "改到周五" || sent.Input["button"] != "revise" {
		t.Fatalf("hook input = %v", sent.Input)
	}
}

func TestPluginCardActionSwitchedOffRefuses(t *testing.T) {
	endpoint := newForkHookEndpoint(t)
	installForkPlugin(t, endpoint, nil)
	setPluginExtensions(t, false, true)
	issueID := createForkTestIssue(t, "[审批] 关闭", "todo", "none")
	inst := agentBotInstallation()
	bindFeishuUser(t, inst, testUserID, "ou_member_off")
	actions := cardActions(t)
	token := buttonToken(t, actions.CardButtons(context.Background(), testWorkspaceID, issueID, testUserID), "approve")

	setPluginExtensions(t, false, false)
	reply := actions.HandleCardAction(context.Background(), inst, clickEvent(token, "om_off", "ou_member_off", ""))
	if reply == nil || !strings.Contains(reply.Toast.Content, "已关闭") || endpoint.calls.Load() != 0 {
		t.Fatalf("switched-off reply = %+v calls=%d", reply, endpoint.calls.Load())
	}
}
