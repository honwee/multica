package handler

import (
	"net/http"
	"strings"

	"github.com/multica-ai/multica/server/internal/auth"
)

// pluginSurfaceAppCookieNames are the cookies that would make the content
// origin a holder of app credentials. Any other cookie on the request comes
// from a sibling site sharing the parent domain (marketing site, analytics)
// and is ignored: never read, echoed or logged.
var pluginSurfaceAppCookieNames = []string{
	auth.AuthCookieName,
	auth.CSRFCookieName,
	auth.SessionCSRFCookieName,
}

// pluginSurfaceRequestCarriesAppCredentials reports whether the request
// presents an Authorization header or one of the app's own auth cookies.
func pluginSurfaceRequestCarriesAppCredentials(r *http.Request) bool {
	if r.Header.Get("Authorization") != "" {
		return true
	}
	for _, name := range pluginSurfaceAppCookieNames {
		if _, err := r.Cookie(name); err == nil {
			return true
		}
	}
	return false
}

// writePluginSurfaceCredentialRejection answers with a short page the app
// origin may embed, so the iframe shows the reason instead of the browser's
// generic "refused to connect" that the global frame-ancestors 'none' causes.
func (h *Handler) writePluginSurfaceCredentialRejection(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", pluginSurfaceRejectionCSP(h.pluginSurfaceAppFrameAncestors()))
	w.WriteHeader(http.StatusBadRequest)
	_, _ = w.Write([]byte(pluginSurfaceCredentialRejectionDocument))
}

func (h *Handler) pluginSurfaceAppFrameAncestors() []string {
	candidates := make([]string, 0, len(h.cfg.AttachmentFrameAncestors)+1)
	candidates = append(candidates, h.cfg.AppURL)
	candidates = append(candidates, h.cfg.AttachmentFrameAncestors...)
	seen := make(map[string]struct{}, len(candidates))
	ancestors := make([]string, 0, len(candidates))
	for _, raw := range candidates {
		source, ok := normalizeFrameAncestorSource(raw)
		if !ok {
			continue
		}
		if _, exists := seen[source]; exists {
			continue
		}
		seen[source] = struct{}{}
		ancestors = append(ancestors, source)
	}
	return ancestors
}

func pluginSurfaceRejectionCSP(ancestors []string) string {
	frameAncestors := "'none'"
	if len(ancestors) > 0 {
		frameAncestors = strings.Join(ancestors, " ")
	}
	return strings.Join([]string{
		"default-src 'none'",
		"style-src 'unsafe-inline'",
		"frame-ancestors " + frameAncestors,
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
	}, "; ")
}

const pluginSurfaceCredentialRejectionDocument = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Plugin blocked</title>
<style>body{font:14px/1.5 system-ui,sans-serif;margin:24px;color:#555}</style></head>
<body><p>This Plugin could not load: the Plugin content origin received app credentials (an app sign-in cookie or Authorization header). Check that the app's cookie domain does not cover the Plugin content origin.</p>
<p>插件无法加载：插件内容域名收到了应用的登录凭据（登录 cookie 或 Authorization 头）。请检查应用 cookie 的作用域名是否覆盖了插件内容域名。</p></body></html>
`
