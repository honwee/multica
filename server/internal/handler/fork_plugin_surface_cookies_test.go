package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/auth"
)

const forkSurfaceContentHost = "plugin-content.example.test"

func forkSurfaceRejectionHandler(t *testing.T) (*Handler, string) {
	t.Helper()
	h := pluginSurfaceTokenHandler(t)
	h.cfg.PluginSurfaceOrigin = "https://" + forkSurfaceContentHost
	h.cfg.AppURL = "https://app.example.test"
	h.cfg.AttachmentFrameAncestors = []string{"https://app.example.test", "https://desktop.example.test/"}
	token, err := h.mintPluginSurfaceToken(validSurfaceClaims())
	if err != nil {
		t.Fatalf("mintPluginSurfaceToken: %v", err)
	}
	return h, token
}

func forkSurfaceRequest(token string) *http.Request {
	request := pluginHandlerRequest(http.MethodGet, "/plugin-surfaces/"+token, nil, map[string]string{"token": token})
	request.Host = forkSurfaceContentHost
	return request
}

func TestServePluginSurfaceRejectsAppCredentialsWithEmbeddableReason(t *testing.T) {
	cases := map[string]func(*http.Request){
		"auth cookie":         func(r *http.Request) { r.Header.Set("Cookie", "_ga=GA1.2.3; "+auth.AuthCookieName+"=session") },
		"csrf cookie":         func(r *http.Request) { r.Header.Set("Cookie", auth.CSRFCookieName+"=x") },
		"session csrf cookie": func(r *http.Request) { r.Header.Set("Cookie", auth.SessionCSRFCookieName+"=x") },
		"authorization":       func(r *http.Request) { r.Header.Set("Authorization", "Bearer mul_x") },
	}
	for name, decorate := range cases {
		t.Run(name, func(t *testing.T) {
			h, token := forkSurfaceRejectionHandler(t)
			request := forkSurfaceRequest(token)
			decorate(request)
			recorder := httptest.NewRecorder()
			h.ServePluginSurface(recorder, request)

			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status=%d, want 400", recorder.Code)
			}
			csp := recorder.Header().Get("Content-Security-Policy")
			if !strings.Contains(csp, "frame-ancestors https://app.example.test https://desktop.example.test;") {
				t.Fatalf("rejection page is not embeddable by the app origins: %s", csp)
			}
			if strings.Contains(csp, "frame-ancestors 'none'") || strings.Contains(csp, "*") {
				t.Fatalf("rejection CSP = %s", csp)
			}
			if got := recorder.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/html") {
				t.Fatalf("content type = %q", got)
			}
			body := recorder.Body.String()
			if strings.Contains(body, token) || strings.Contains(body, "session") || strings.Contains(body, "mul_x") {
				t.Fatalf("rejection page leaked request data: %s", body)
			}
		})
	}
}

// Cookies from sibling sites on the parent domain must not block the surface.
// The token here does not open an installation, so passing the credential gate
// shows up as the token check's 404 rather than the 400 rejection.
func TestServePluginSurfaceIgnoresForeignParentDomainCookies(t *testing.T) {
	h, token := forkSurfaceRejectionHandler(t)
	h.PluginSurfaceTokens = nil
	request := forkSurfaceRequest(token)
	request.Header.Set("Cookie", "_ga=GA1.2.3; Hm_lvt_abc=1; multica_authx=1; session=foo")
	recorder := httptest.NewRecorder()
	h.ServePluginSurface(recorder, request)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("foreign cookies: status=%d body=%s, want the credential gate to pass", recorder.Code, recorder.Body.String())
	}
}

func TestPluginSurfaceRejectionCSPFailsClosedWithoutAppOrigin(t *testing.T) {
	h := &Handler{}
	if csp := pluginSurfaceRejectionCSP(h.pluginSurfaceAppFrameAncestors()); !strings.Contains(csp, "frame-ancestors 'none'") {
		t.Fatalf("no configured app origin: %s", csp)
	}
}

// DB-backed: a real installed surface still serves 200 with the same CSP when
// unrelated parent-domain cookies arrive.
func TestServePluginSurfaceServesWithForeignCookiesAndUnchangedCSP(t *testing.T) {
	withPluginsV1Flag(t, testHandler, true)
	cleanupPluginInstallations(t)
	withHostCapabilities(t)

	published := publishUploadedBundle(t, packageManifest("1.0.0"), "console.log('cookie');\n")
	installationID := installPublishedVersion(t, published.Versions[0].ID)

	previousOrigin, previousTokens := testHandler.cfg.PluginSurfaceOrigin, testHandler.PluginSurfaceTokens
	testHandler.cfg.PluginSurfaceOrigin = "https://" + forkSurfaceContentHost
	testHandler.PluginSurfaceTokens, _ = NewPluginSurfaceTokenBox(bytes.Repeat([]byte{5}, 32))
	t.Cleanup(func() {
		testHandler.cfg.PluginSurfaceOrigin, testHandler.PluginSurfaceTokens = previousOrigin, previousTokens
	})

	launchRecorder := httptest.NewRecorder()
	testHandler.GetPluginSurfaceLaunch(launchRecorder, pluginHandlerRequest(http.MethodGet, "/launch", nil, map[string]string{
		"id": testWorkspaceID, "installationId": installationID, "surfaceKey": "hello",
	}))
	if launchRecorder.Code != http.StatusOK {
		t.Fatalf("launch: status=%d body=%s", launchRecorder.Code, launchRecorder.Body.String())
	}
	var launch pluginSurfaceLaunch
	if err := json.Unmarshal(launchRecorder.Body.Bytes(), &launch); err != nil {
		t.Fatalf("decode launch: %v", err)
	}
	token := launch.URL[strings.LastIndex(launch.URL, "/")+1:]

	clean := httptest.NewRecorder()
	testHandler.ServePluginSurface(clean, forkSurfaceRequest(token))
	withCookies := forkSurfaceRequest(token)
	withCookies.Header.Set("Cookie", "_ga=GA1.2.3; Hm_lvt_abc=1")
	foreign := httptest.NewRecorder()
	testHandler.ServePluginSurface(foreign, withCookies)

	if clean.Code != http.StatusOK || foreign.Code != http.StatusOK {
		t.Fatalf("clean status=%d, foreign-cookie status=%d body=%s", clean.Code, foreign.Code, foreign.Body.String())
	}
	want := pluginSurfaceCSP([]string{"issues:read"})
	if got := foreign.Header().Get("Content-Security-Policy"); got != want || clean.Header().Get("Content-Security-Policy") != want {
		t.Fatalf("surface CSP changed: clean=%q foreign=%q want=%q", clean.Header().Get("Content-Security-Policy"), got, want)
	}
	if strings.Contains(foreign.Header().Get("Content-Security-Policy"), "frame-ancestors") {
		t.Fatal("valid surface gained a frame-ancestors restriction")
	}
}
