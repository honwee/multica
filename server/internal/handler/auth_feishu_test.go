package handler

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/iotest"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/integrations/lark"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type feishuRoundTripper func(*http.Request) (*http.Response, error)

func (fn feishuRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	return fn(req)
}

func feishuResponse(req *http.Request, status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader(body)),
		Request:    req,
	}
}

func TestFeishuLoginNotConfigured(t *testing.T) {
	t.Setenv("FEISHU_APP_ID", "")
	t.Setenv("FEISHU_APP_SECRET", "")
	h := newTestHandler(Config{})
	req := httptest.NewRequest(http.MethodPost, "/auth/feishu", strings.NewReader(`{"code":"test-code"}`))
	var got struct {
		Code string `json:"code"`
	}
	testutil.Call(t, h.FeishuLogin, req).Want(http.StatusForbidden).JSON(&got)
	if got.Code != "feishu_login_not_configured" {
		t.Fatalf("got code=%q, want feishu_login_not_configured", got.Code)
	}
}

func TestFeishuLoginTokenFailures(t *testing.T) {
	t.Setenv("FEISHU_APP_ID", "cli_test")
	t.Setenv("FEISHU_APP_SECRET", "test-secret")
	tests := []struct {
		name       string
		status     int
		body       string
		readErr    error
		requestErr error
		wantStatus int
		wantCode   string
	}{
		{name: "invalid grant", status: 400, body: `{"code":20050,"error":"invalid_grant","error_description":"code expired"}`, wantStatus: 400, wantCode: "oauth_code_invalid"},
		{name: "invalid client", status: 401, body: `{"code":20048,"error":"invalid_client"}`, wantStatus: 502},
		{name: "unknown provider error", status: 400, body: `{"code":20049,"error":"future_error"}`, wantStatus: 502},
		{name: "5xx takes precedence over invalid grant", status: 500, body: `{"error":"invalid_grant"}`, wantStatus: 502},
		{name: "ok status with non-zero code", status: 200, body: `{"code":20050,"error":"invalid_grant"}`, wantStatus: 502},
		{name: "malformed provider error", status: 400, body: `<html>bad gateway</html>`, wantStatus: 502},
		{name: "empty provider error", status: 400, wantStatus: 502},
		{name: "malformed token", status: 200, body: `{`, wantStatus: 502},
		{name: "missing access token", status: 200, body: `{"code":0}`, wantStatus: 502},
		{name: "null token", status: 200, body: `null`, wantStatus: 502},
		{name: "empty access token", status: 200, body: `{"code":0,"access_token":""}`, wantStatus: 502},
		{name: "wrong access token type", status: 200, body: `{"code":0,"access_token":42}`, wantStatus: 502},
		{name: "read failure", status: 200, readErr: io.ErrUnexpectedEOF, wantStatus: 502},
		{name: "transport failure", requestErr: errors.New("provider unavailable"), wantStatus: 502},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newTestHandler(Config{})
			h.feishuOAuthHTTPClient = &http.Client{Transport: feishuRoundTripper(func(req *http.Request) (*http.Response, error) {
				if !strings.HasSuffix(req.URL.Path, "/oauth/token") {
					t.Fatalf("token failure must not fetch userinfo: %s", req.URL)
				}
				if tt.requestErr != nil {
					return nil, tt.requestErr
				}
				resp := feishuResponse(req, tt.status, tt.body)
				if tt.readErr != nil {
					resp.Body = io.NopCloser(iotest.ErrReader(tt.readErr))
				}
				return resp, nil
			})}
			req := httptest.NewRequest(http.MethodPost, "/auth/feishu", strings.NewReader(`{"code":"test-code"}`))
			var got struct {
				Error string `json:"error"`
				Code  string `json:"code"`
			}
			testutil.Call(t, h.FeishuLogin, req).Want(tt.wantStatus).JSON(&got)
			if got.Code != tt.wantCode || got.Error == "" {
				t.Fatalf("got code=%q error=%q, want code=%q and a fallback message", got.Code, got.Error, tt.wantCode)
			}
		})
	}
}

func TestFeishuLoginUserInfoFailures(t *testing.T) {
	t.Setenv("FEISHU_APP_ID", "cli_test")
	t.Setenv("FEISHU_APP_SECRET", "test-secret")
	tests := []struct {
		name       string
		status     int
		body       string
		readErr    error
		requestErr error
		wantStatus int
		wantCode   string
	}{
		{name: "unauthorized", status: 401, body: `{"code":99991668,"msg":"invalid token"}`, wantStatus: 502},
		{name: "rate limited", status: 429, body: `{"code":99991400,"msg":"rate limited"}`, wantStatus: 502},
		{name: "provider unavailable", status: 503, body: `<html>bad gateway</html>`, wantStatus: 502},
		{name: "ok status with non-zero code", status: 200, body: `{"code":99991668,"msg":"invalid token"}`, wantStatus: 502},
		{name: "missing data on a successful response", status: 200, body: `{"code":0,"msg":"success"}`, wantStatus: 502},
		{name: "missing email and open id on a successful response", status: 200, body: `{"code":0,"data":{"name":"No Email"}}`, wantStatus: 400, wantCode: "feishu_account_no_email"},
		{name: "blank emails on a successful response", status: 200, body: `{"code":0,"data":{"email":"   ","enterprise_email":"  "}}`, wantStatus: 400, wantCode: "feishu_account_no_email"},
		{name: "null profile", status: 200, body: `null`, wantStatus: 502},
		{name: "malformed profile", status: 200, body: `{`, wantStatus: 502},
		{name: "wrong email type", status: 200, body: `{"code":0,"data":{"email":42}}`, wantStatus: 502},
		{name: "read failure", status: 200, readErr: io.ErrUnexpectedEOF, wantStatus: 502},
		{name: "transport failure", requestErr: errors.New("provider unavailable"), wantStatus: 502},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newTestHandler(Config{})
			h.feishuOAuthHTTPClient = &http.Client{Transport: feishuRoundTripper(func(req *http.Request) (*http.Response, error) {
				if strings.HasSuffix(req.URL.Path, "/oauth/token") {
					return feishuResponse(req, http.StatusOK, `{"code":0,"access_token":"u-test-token","token_type":"Bearer"}`), nil
				}
				if tt.requestErr != nil {
					return nil, tt.requestErr
				}
				resp := feishuResponse(req, tt.status, tt.body)
				if tt.readErr != nil {
					resp.Body = io.NopCloser(iotest.ErrReader(tt.readErr))
				}
				return resp, nil
			})}
			req := httptest.NewRequest(http.MethodPost, "/auth/feishu", strings.NewReader(`{"code":"test-code"}`))
			var got struct {
				Error string `json:"error"`
				Code  string `json:"code"`
			}
			testutil.Call(t, h.FeishuLogin, req).Want(tt.wantStatus).JSON(&got)
			if got.Code != tt.wantCode || got.Error == "" {
				t.Fatalf("got code=%q error=%q, want code=%q and a fallback message", got.Code, got.Error, tt.wantCode)
			}
		})
	}
}

// TestFeishuLoginEnterpriseEmailPreferred exercises the happy path through a
// fake provider and asserts the enterprise email wins over the personal one.
func TestFeishuLoginEnterpriseEmailPreferred(t *testing.T) {
	t.Setenv("FEISHU_APP_ID", "cli_test")
	t.Setenv("FEISHU_APP_SECRET", "test-secret")
	email := "feishu-enterprise@lumistedu-test.com"
	dbfx.Cleanup(t, `DELETE FROM "user" WHERE email = $1`, email)
	h := *testHandler
	h.cfg = Config{AllowSignup: true}
	h.feishuOAuthHTTPClient = &http.Client{Transport: feishuRoundTripper(func(req *http.Request) (*http.Response, error) {
		if strings.HasSuffix(req.URL.Path, "/oauth/token") {
			return feishuResponse(req, http.StatusOK, `{"code":0,"access_token":"u-test-token","token_type":"Bearer"}`), nil
		}
		if got := req.Header.Get("Authorization"); got != "Bearer u-test-token" {
			t.Fatalf("userinfo called with Authorization=%q", got)
		}
		return feishuResponse(req, http.StatusOK, `{"code":0,"msg":"success","data":{"name":"企业 用户","avatar_url":"https://avatar.example/a.png","email":"personal@example.com","enterprise_email":"Feishu-Enterprise@lumistedu-test.com","open_id":"ou_x"}}`), nil
	})}
	req := httptest.NewRequest(http.MethodPost, "/auth/feishu", strings.NewReader(`{"code":"test-code"}`))
	var got LoginResponse
	testutil.Call(t, h.FeishuLogin, req).Want(http.StatusOK).JSON(&got)
	if got.Token == "" {
		t.Fatal("expected a session token")
	}
	if got.User.Email != email {
		t.Fatalf("got email %q, want the lowercased enterprise email %q", got.User.Email, email)
	}
	if got.User.Name != "企业 用户" {
		t.Fatalf("got name %q, want the Feishu profile name", got.User.Name)
	}
}

// TestFeishuLoginWithoutEmailUsesOpenID verifies that tenants without employee
// mailboxes can still sign in with a stable, non-deliverable internal account.
func TestFeishuLoginWithoutEmailUsesOpenID(t *testing.T) {
	t.Setenv("FEISHU_APP_ID", "cli_test")
	t.Setenv("FEISHU_APP_SECRET", "test-secret")
	email := "ou_no_email@feishu.invalid"
	dbfx.Cleanup(t, `DELETE FROM "user" WHERE email = $1`, email)
	h := *testHandler
	h.cfg = Config{AllowSignup: true}
	h.feishuOAuthHTTPClient = &http.Client{Transport: feishuRoundTripper(func(req *http.Request) (*http.Response, error) {
		if strings.HasSuffix(req.URL.Path, "/oauth/token") {
			return feishuResponse(req, http.StatusOK, `{"code":0,"access_token":"u-test-token","token_type":"Bearer"}`), nil
		}
		return feishuResponse(req, http.StatusOK, `{"code":0,"msg":"success","data":{"name":"无邮箱用户","open_id":"ou_no_email"}}`), nil
	})}
	req := httptest.NewRequest(http.MethodPost, "/auth/feishu", strings.NewReader(`{"code":"test-code"}`))
	var got LoginResponse
	testutil.Call(t, h.FeishuLogin, req).Want(http.StatusOK).JSON(&got)
	if got.Token == "" {
		t.Fatal("expected a session token")
	}
	if got.User.Email != email {
		t.Fatalf("got email %q, want the Open ID based internal account %q", got.User.Email, email)
	}
	if got.User.Name != "无邮箱用户" {
		t.Fatalf("got name %q, want the Feishu profile name", got.User.Name)
	}
}

// TestFeishuLoginUsesLinkedOpenID proves that a Feishu identity returns to an
// existing account instead of creating a second open_id-based user.
func TestFeishuLoginUsesLinkedOpenID(t *testing.T) {
	t.Setenv("FEISHU_APP_ID", "cli_test")
	t.Setenv("FEISHU_APP_SECRET", "test-secret")
	email := "linked-feishu@example.com"
	openID := "ou_linked_identity"
	internalEmail := openID + "@feishu.invalid"
	dbfx.Cleanup(t, `DELETE FROM "user" WHERE email = $1 OR email = $2`, email, internalEmail)

	h := *testHandler
	h.cfg = Config{AllowSignup: true}
	existing, _, err := h.findOrCreateUser(context.Background(), email)
	if err != nil {
		t.Fatalf("create linked user: %v", err)
	}
	if _, err := h.Queries.SetUserFeishuIdentity(context.Background(), db.SetUserFeishuIdentityParams{
		ID: existing.ID, FeishuOpenID: openID,
	}); err != nil {
		t.Fatalf("link Feishu identity: %v", err)
	}

	h.feishuOAuthHTTPClient = &http.Client{Transport: feishuRoundTripper(func(req *http.Request) (*http.Response, error) {
		if strings.HasSuffix(req.URL.Path, "/oauth/token") {
			return feishuResponse(req, http.StatusOK, `{"code":0,"access_token":"u-test-token","token_type":"Bearer"}`), nil
		}
		return feishuResponse(req, http.StatusOK, `{"code":0,"msg":"success","data":{"name":"已关联用户","open_id":"ou_linked_identity"}}`), nil
	})}
	req := httptest.NewRequest(http.MethodPost, "/auth/feishu", strings.NewReader(`{"code":"test-code"}`))
	var got LoginResponse
	testutil.Call(t, h.FeishuLogin, req).Want(http.StatusOK).JSON(&got)

	if got.User.ID != uuidToString(existing.ID) {
		t.Fatalf("got user ID %q, want linked user %q", got.User.ID, uuidToString(existing.ID))
	}
	if got.User.Email != email {
		t.Fatalf("got email %q, want original account email %q", got.User.Email, email)
	}
	if _, err := h.Queries.GetUserByEmail(context.Background(), internalEmail); err == nil {
		t.Fatal("Feishu login created a duplicate open_id account despite the existing link")
	}
}

// TestFeishuLoginStoresUnionIdentity verifies that a first sign-in records the
// union_id and tenant_key next to the open_id, so the organization directory
// can match the account across every app of the tenant.
func TestFeishuLoginStoresUnionIdentity(t *testing.T) {
	t.Setenv("FEISHU_APP_ID", "cli_test")
	t.Setenv("FEISHU_APP_SECRET", "test-secret")
	email := "feishu-union@lumistedu-test.com"
	dbfx.Cleanup(t, `DELETE FROM "user" WHERE email = $1`, email)
	h := *testHandler
	h.cfg = Config{AllowSignup: true}
	h.feishuOAuthHTTPClient = &http.Client{Transport: feishuRoundTripper(func(req *http.Request) (*http.Response, error) {
		if strings.HasSuffix(req.URL.Path, "/oauth/token") {
			return feishuResponse(req, http.StatusOK, `{"code":0,"access_token":"u-test-token","token_type":"Bearer"}`), nil
		}
		return feishuResponse(req, http.StatusOK, `{"code":0,"msg":"success","data":{"name":"Union User","enterprise_email":"feishu-union@lumistedu-test.com","open_id":"ou_union_login","union_id":"ON_Union_Login","tenant_key":"tenant_abc"}}`), nil
	})}
	req := httptest.NewRequest(http.MethodPost, "/auth/feishu", strings.NewReader(`{"code":"test-code"}`))
	var got LoginResponse
	testutil.Call(t, h.FeishuLogin, req).Want(http.StatusOK).JSON(&got)

	user, err := h.Queries.GetUserByEmail(context.Background(), email)
	if err != nil {
		t.Fatalf("load user: %v", err)
	}
	if !user.FeishuUnionID.Valid || user.FeishuUnionID.String != "on_union_login" {
		t.Fatalf("stored union_id = %+v, want on_union_login", user.FeishuUnionID)
	}
	if !user.FeishuOpenID.Valid || user.FeishuOpenID.String != "ou_union_login" {
		t.Fatalf("stored open_id = %+v, want ou_union_login", user.FeishuOpenID)
	}
	if !user.FeishuTenantKey.Valid || user.FeishuTenantKey.String != "tenant_abc" {
		t.Fatalf("stored tenant_key = %+v, want tenant_abc", user.FeishuTenantKey)
	}
}

// TestFeishuLoginUsesLinkedUnionID proves that a sign-in through a different
// Feishu app (a different open_id) still lands on the account linked by
// union_id, and that the newer open_id replaces the stale one.
func TestFeishuLoginUsesLinkedUnionID(t *testing.T) {
	t.Setenv("FEISHU_APP_ID", "cli_test")
	t.Setenv("FEISHU_APP_SECRET", "test-secret")
	email := "linked-union@example.com"
	internalEmail := "ou_other_app@feishu.invalid"
	dbfx.Cleanup(t, `DELETE FROM "user" WHERE email = $1 OR email = $2`, email, internalEmail)

	h := *testHandler
	h.cfg = Config{AllowSignup: true}
	existing, _, err := h.findOrCreateUser(context.Background(), email)
	if err != nil {
		t.Fatalf("create linked user: %v", err)
	}
	if _, err := h.Queries.SetUserFeishuIdentity(context.Background(), db.SetUserFeishuIdentityParams{
		ID: existing.ID, FeishuOpenID: "ou_first_app", FeishuUnionID: "on_shared_union",
	}); err != nil {
		t.Fatalf("link Feishu identity: %v", err)
	}

	h.feishuOAuthHTTPClient = &http.Client{Transport: feishuRoundTripper(func(req *http.Request) (*http.Response, error) {
		if strings.HasSuffix(req.URL.Path, "/oauth/token") {
			return feishuResponse(req, http.StatusOK, `{"code":0,"access_token":"u-test-token","token_type":"Bearer"}`), nil
		}
		return feishuResponse(req, http.StatusOK, `{"code":0,"msg":"success","data":{"name":"Other App","open_id":"ou_other_app","union_id":"on_shared_union"}}`), nil
	})}
	req := httptest.NewRequest(http.MethodPost, "/auth/feishu", strings.NewReader(`{"code":"test-code"}`))
	var got LoginResponse
	testutil.Call(t, h.FeishuLogin, req).Want(http.StatusOK).JSON(&got)

	if got.User.ID != uuidToString(existing.ID) {
		t.Fatalf("got user ID %q, want union-linked user %q", got.User.ID, uuidToString(existing.ID))
	}
	if _, err := h.Queries.GetUserByEmail(context.Background(), internalEmail); err == nil {
		t.Fatal("Feishu login created a duplicate account despite the union_id link")
	}
	user, err := h.Queries.GetUser(context.Background(), existing.ID)
	if err != nil {
		t.Fatalf("load user: %v", err)
	}
	if !user.FeishuOpenID.Valid || user.FeishuOpenID.String != "ou_other_app" {
		t.Fatalf("stored open_id = %+v, want the login app's ou_other_app", user.FeishuOpenID)
	}
}

// TestFeishuLoginJoinsWorkspaceByOrganizationRule: with automatic sync on,
// a first sign-in from someone the rules cover lands them in the workspace
// with the mapped role; someone outside every rule is not admitted.
func TestFeishuLoginJoinsWorkspaceByOrganizationRule(t *testing.T) {
	t.Setenv("FEISHU_APP_ID", "cli_test")
	t.Setenv("FEISHU_APP_SECRET", "test-secret")
	fixture := newFeishuOrgHandlerFixture(t)
	req := feishuOrgRequest(fixture.ownerID, http.MethodPut, fixture.workspaceID, "/api/workspaces/"+fixture.workspaceID+"/lark/organization", UpdateLarkOrganizationRequest{
		InstallationID: fixture.installationID, Enabled: true, AutoSync: true,
		Mappings: []LarkOrganizationMappingResponse{
			{Kind: "department", ExternalID: "d1", ExternalName: "Engineering", MemberRole: feishuOrgRole("admin")},
			{Kind: "department", ExternalID: "d3", ExternalName: "Leadership", MemberRole: feishuOrgRole("owner")},
		},
	})
	w := httptest.NewRecorder()
	testHandler.UpdateLarkOrganization(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("save status = %d, body=%s", w.Code, w.Body.String())
	}
	joinerEmail := "feishu-joiner-" + fixture.workspaceID + "@corp.example.com"
	outsiderEmail := "feishu-outsider-" + fixture.workspaceID + "@corp.example.com"
	leaderEmail := "feishu-leader-" + fixture.workspaceID + "@corp.example.com"
	dbfx.Cleanup(t, `DELETE FROM "user" WHERE email = $1 OR email = $2 OR email = $3`, joinerEmail, outsiderEmail, leaderEmail)
	snapshot, _ := json.Marshal(lark.OrgSnapshot{
		Complete:    true,
		Departments: []lark.OrgDepartment{{ID: "d1", Name: "Engineering", ParentID: "0"}, {ID: "d2", Name: "Sales", ParentID: "0"}, {ID: "d3", Name: "Leadership", ParentID: "0"}},
		Users: []lark.OrgUser{
			{OpenID: "ou_joiner_dir", UnionID: "on_joiner", EnterpriseEmail: joinerEmail, Name: "Joiner", DepartmentIDs: []string{"d1"}, Active: true},
			{OpenID: "ou_outsider_dir", UnionID: "on_outsider", EnterpriseEmail: outsiderEmail, Name: "Outsider", DepartmentIDs: []string{"d2"}, Active: true},
			{OpenID: "ou_leader_dir", UnionID: "on_leader", EnterpriseEmail: leaderEmail, Name: "Leader", DepartmentIDs: []string{"d3"}, Active: true},
		},
	})
	if _, err := testHandler.Queries.UpsertFeishuOrgDirectory(context.Background(), db.UpsertFeishuOrgDirectoryParams{
		InstallationID: parseUUID(fixture.installationID), Snapshot: snapshot, FetchedBy: parseUUID(fixture.ownerID),
	}); err != nil {
		t.Fatalf("seed directory: %v", err)
	}

	login := func(unionID, openID, email string) LoginResponse {
		t.Helper()
		h := *testHandler
		h.cfg = Config{AllowSignup: true}
		h.feishuOAuthHTTPClient = &http.Client{Transport: feishuRoundTripper(func(req *http.Request) (*http.Response, error) {
			if strings.HasSuffix(req.URL.Path, "/oauth/token") {
				return feishuResponse(req, http.StatusOK, `{"code":0,"access_token":"u-test-token","token_type":"Bearer"}`), nil
			}
			return feishuResponse(req, http.StatusOK, `{"code":0,"msg":"success","data":{"name":"Person","enterprise_email":"`+email+`","open_id":"`+openID+`","union_id":"`+unionID+`","tenant_key":"tenant_join"}}`), nil
		})}
		req := httptest.NewRequest(http.MethodPost, "/auth/feishu", strings.NewReader(`{"code":"test-code"}`))
		var got LoginResponse
		testutil.Call(t, h.FeishuLogin, req).Want(http.StatusOK).JSON(&got)
		return got
	}

	joiner := login("on_joiner", "ou_joiner_login", joinerEmail)
	var role string
	var managed pgtype.Text
	if err := testPool.QueryRow(context.Background(), `SELECT role, feishu_managed_role FROM member WHERE workspace_id = $1 AND user_id = $2 AND disabled_at IS NULL`, fixture.workspaceID, joiner.User.ID).Scan(&role, &managed); err != nil {
		t.Fatalf("joiner is not a member: %v", err)
	}
	if role != "admin" || !managed.Valid || managed.String != "admin" {
		t.Fatalf("joiner role = %q managed = %+v, want admin from the rule", role, managed)
	}
	if count := dbfx.Count(t, `SELECT count(*) FROM feishu_org_membership WHERE workspace_id = $1 AND user_id = $2 AND active`, fixture.workspaceID, joiner.User.ID); count != 1 {
		t.Fatalf("joiner group memberships = %d, want 1", count)
	}
	user, err := testHandler.Queries.GetUser(context.Background(), parseUUID(joiner.User.ID))
	if err != nil || !user.OnboardedAt.Valid {
		t.Fatalf("joiner must be marked onboarded: %+v err=%v", user.OnboardedAt, err)
	}

	outsider := login("on_outsider", "ou_outsider_login", outsiderEmail)
	if count := dbfx.Count(t, `SELECT count(*) FROM member WHERE workspace_id = $1 AND user_id = $2`, fixture.workspaceID, outsider.User.ID); count != 0 {
		t.Fatal("a user outside every rule must not be admitted")
	}

	// An owner rule never grants owner unattended: the person joins as an
	// unmanaged admin so a later manual apply can promote them.
	leader := login("on_leader", "ou_leader_login", leaderEmail)
	if err := testPool.QueryRow(context.Background(), `SELECT role, feishu_managed_role FROM member WHERE workspace_id = $1 AND user_id = $2 AND disabled_at IS NULL`, fixture.workspaceID, leader.User.ID).Scan(&role, &managed); err != nil {
		t.Fatalf("leader is not a member: %v", err)
	}
	if role != "admin" || managed.Valid {
		t.Fatalf("leader role = %q managed = %+v, want unmanaged admin", role, managed)
	}
}
