package lark

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
)

// captureLogger returns a DEBUG-level text logger writing into buf so
// tests can assert on the level a message was emitted at.
func captureLogger(buf *bytes.Buffer) *slog.Logger {
	return slog.New(slog.NewTextHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
}

func newBotInfoFake(t *testing.T, contact http.HandlerFunc) *larkFakeServer {
	t.Helper()
	fake := newLarkFake(t)
	fake.stubToken("tok_union", 7200)
	fake.mux.HandleFunc("/open-apis/bot/v3/info", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"code": 0, "msg": "ok", "bot": map[string]any{"open_id": "ou_bot_x"}})
	})
	fake.mux.HandleFunc("/open-apis/contact/v3/users/ou_bot_x", contact)
	return fake
}

func TestGetBotInfo_UnionIDExpectedCodesLogInfo(t *testing.T) {
	for _, code := range []int{41050, 41012} {
		var buf bytes.Buffer
		fake := newBotInfoFake(t, func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, map[string]any{"code": code, "msg": "no user authority"})
		})
		c := NewHTTPAPIClient(HTTPClientConfig{BaseURL: fake.URL(), Logger: captureLogger(&buf)})
		info, err := c.GetBotInfo(context.Background(), testCreds())
		if err != nil {
			t.Fatalf("code %d: GetBotInfo errored: %v", code, err)
		}
		if info.UnionID != "" || string(info.OpenID) != "ou_bot_x" {
			t.Fatalf("code %d: got %+v", code, info)
		}
		out := buf.String()
		if strings.Contains(out, "level=WARN") {
			t.Errorf("code %d: want no WARN, got %s", code, out)
		}
		if !strings.Contains(out, "level=INFO") || !strings.Contains(out, "outside contact scope") {
			t.Errorf("code %d: want INFO outside-contact-scope line, got %s", code, out)
		}
	}
}

// Production Feishu returns 41050 as HTTP 400 with the code in the
// body, not as a 2xx envelope; that shape must also log at INFO.
func TestGetBotInfo_UnionIDExpectedCodeOverHTTP400LogsInfo(t *testing.T) {
	for _, code := range []int{41050, 41012} {
		var buf bytes.Buffer
		fake := newBotInfoFake(t, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = fmt.Fprintf(w, `{"code":%d,"msg":"no user authority error"}`, code)
		})
		c := NewHTTPAPIClient(HTTPClientConfig{BaseURL: fake.URL(), Logger: captureLogger(&buf)})
		if _, err := c.GetBotInfo(context.Background(), testCreds()); err != nil {
			t.Fatalf("code %d: GetBotInfo errored: %v", code, err)
		}
		out := buf.String()
		if strings.Contains(out, "level=WARN") || !strings.Contains(out, "outside contact scope") {
			t.Errorf("code %d over HTTP 400: want INFO only, got %s", code, out)
		}
	}
}

func TestGetBotInfo_UnionIDOtherFailuresStayWarn(t *testing.T) {
	cases := map[string]http.HandlerFunc{
		"other code": func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, map[string]any{"code": 99991002, "msg": "no permission"})
		},
		"other code over HTTP 400": func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"code":40001,"msg":"bad request"}`))
		},
		"5xx": func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "boom", http.StatusInternalServerError)
		},
		"network": func(w http.ResponseWriter, r *http.Request) {
			hj, ok := w.(http.Hijacker)
			if !ok {
				t.Fatal("hijack unsupported")
			}
			conn, _, err := hj.Hijack()
			if err != nil {
				t.Fatal(err)
			}
			_ = conn.Close()
		},
	}
	for name, h := range cases {
		var buf bytes.Buffer
		fake := newBotInfoFake(t, h)
		c := NewHTTPAPIClient(HTTPClientConfig{BaseURL: fake.URL(), Logger: captureLogger(&buf)})
		if _, err := c.GetBotInfo(context.Background(), testCreds()); err != nil {
			t.Fatalf("%s: GetBotInfo errored: %v", name, err)
		}
		if out := buf.String(); !strings.Contains(out, "level=WARN") || !strings.Contains(out, "bot union_id lookup failed") {
			t.Errorf("%s: want WARN lookup-failed line, got %s", name, out)
		}
	}
}

func TestIsBotUnionIDUnavailable(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want bool
	}{
		{&APIError{Op: "contact users", Code: 41050}, true},
		{&APIError{Op: "contact users", Code: 41012}, true},
		{&APIError{Op: "contact users", Code: 99991002}, false},
		{fmt.Errorf("contact users: %w", &larkAPIStatusError{StatusCode: 400, Code: 41050}), true},
		{fmt.Errorf("contact users: %w", &larkAPIStatusError{StatusCode: 400, Code: 40001}), false},
		{fmt.Errorf("contact users: %w", &larkAPIStatusError{StatusCode: 502}), false},
		{errors.New("contact users: http do: connection reset"), false},
		{nil, false},
	} {
		if got := isBotUnionIDUnavailable(tc.err); got != tc.want {
			t.Errorf("%v: got %v want %v", tc.err, got, tc.want)
		}
	}
}

type stubBackfillStore struct {
	rows []Installation
	set  []SetInstallationBotUnionIDParams
}

func (s *stubBackfillStore) ListActiveLarkInstallations(context.Context) ([]Installation, error) {
	return s.rows, nil
}

func (s *stubBackfillStore) SetLarkInstallationBotUnionID(_ context.Context, arg SetInstallationBotUnionIDParams) error {
	s.set = append(s.set, arg)
	return nil
}

type stubDecrypter struct{}

func (stubDecrypter) DecryptAppSecret(Installation) (string, error) { return "secret", nil }

func TestBackfillBotUnionIDs_ExpectedCodesContinueWithoutWarn(t *testing.T) {
	var buf bytes.Buffer
	logger := captureLogger(&buf)
	clientFor := func(code int) APIClient {
		fake := newBotInfoFake(t, func(w http.ResponseWriter, r *http.Request) {
			// Mirror production: Feishu answers these codes with HTTP 400.
			w.WriteHeader(http.StatusBadRequest)
			_, _ = fmt.Fprintf(w, `{"code":%d,"msg":"no user authority error"}`, code)
		})
		return NewHTTPAPIClient(HTTPClientConfig{BaseURL: fake.URL(), Logger: logger})
	}
	api := &stubAPI{
		byApp:      map[string]APIClient{"cli_a": clientFor(41050), "cli_b": clientFor(41012)},
		unionByApp: map[string]string{"cli_ok": "on_ok"},
	}
	store := &stubBackfillStore{rows: []Installation{
		{ID: pgtype.UUID{Bytes: [16]byte{1}, Valid: true}, AppID: "cli_a"},
		{ID: pgtype.UUID{Bytes: [16]byte{2}, Valid: true}, AppID: "cli_b"},
		{ID: pgtype.UUID{Bytes: [16]byte{3}, Valid: true}, AppID: "cli_ok"},
		{ID: pgtype.UUID{Bytes: [16]byte{4}, Valid: true}, AppID: "cli_done", BotUnionID: pgtype.Text{String: "on_done", Valid: true}},
	}}
	BackfillBotUnionIDs(context.Background(), store, api, stubDecrypter{}, logger)

	if len(store.set) != 1 || store.set[0].ID.Bytes[0] != 3 || store.set[0].BotUnionID.String != "on_ok" {
		t.Fatalf("want only cli_ok stamped, got %+v", store.set)
	}
	out := buf.String()
	if strings.Contains(out, "level=WARN") {
		t.Errorf("want no WARN for expected codes, got %s", out)
	}
	if !strings.Contains(out, "attempted=3 filled=1 missed=2 errored=0") {
		t.Errorf("want summary attempted=3 filled=1 missed=2 errored=0, got %s", out)
	}
}

// stubAPI answers GetBotInfo from unionByApp when present, otherwise
// delegates to the per-app real HTTP client in byApp (backed by a fake
// Lark server answering the contact lookup with a fixed code).
type stubAPI struct {
	APIClient
	byApp      map[string]APIClient
	unionByApp map[string]string
}

func (s *stubAPI) IsConfigured() bool { return true }

func (s *stubAPI) GetBotInfo(ctx context.Context, creds InstallationCredentials) (BotInfo, error) {
	if u, ok := s.unionByApp[creds.AppID]; ok {
		return BotInfo{OpenID: OpenID("ou_" + creds.AppID), UnionID: u}, nil
	}
	return s.byApp[creds.AppID].GetBotInfo(ctx, creds)
}
