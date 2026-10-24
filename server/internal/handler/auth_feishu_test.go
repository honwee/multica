package handler

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/iotest"

	"github.com/multica-ai/multica/server/internal/testutil"
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
