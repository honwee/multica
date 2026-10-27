package handler

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/analytics"
	"github.com/multica-ai/multica/server/internal/auth"
	"github.com/multica-ai/multica/server/internal/logger"
	obsmetrics "github.com/multica-ai/multica/server/internal/metrics"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

const feishuLoginCodeAccountWithoutEmail = "feishu_account_no_email"

// Feishu (Lark mainland) OAuth endpoints. The login flow targets 飞书
// (open.feishu.cn) deployments; international Lark tenants use the Lark bot
// integration's own region handling, which is separate from login.
const (
	feishuOAuthTokenURL = "https://open.feishu.cn/open-apis/authen/v2/oauth/token"
	feishuUserInfoURL   = "https://open.feishu.cn/open-apis/authen/v1/user_info"
)

type FeishuLoginRequest struct {
	Code        string `json:"code"`
	RedirectURI string `json:"redirect_uri"`
}

// feishuTokenResponse covers both success and error shapes of the v2 OAuth
// token endpoint: success carries code=0 plus access_token, failures carry a
// non-zero code with error/error_description.
type feishuTokenResponse struct {
	Code             int    `json:"code"`
	AccessToken      string `json:"access_token"`
	TokenType        string `json:"token_type"`
	Error            string `json:"error"`
	ErrorDescription string `json:"error_description"`
}

type feishuUserInfo struct {
	Name            string `json:"name"`
	AvatarURL       string `json:"avatar_url"`
	Email           string `json:"email"`
	EnterpriseEmail string `json:"enterprise_email"`
	OpenID          string `json:"open_id"`
}

type feishuUserInfoResponse struct {
	Code int             `json:"code"`
	Msg  string          `json:"msg"`
	Data *feishuUserInfo `json:"data"`
}

func (h *Handler) feishuHTTPClient() *http.Client {
	if h.feishuOAuthHTTPClient != nil {
		return h.feishuOAuthHTTPClient
	}
	return http.DefaultClient
}

func (h *Handler) FeishuLogin(w http.ResponseWriter, r *http.Request) {
	var req FeishuLoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.Code == "" {
		writeError(w, http.StatusBadRequest, "code is required")
		return
	}

	appID := os.Getenv("FEISHU_APP_ID")
	appSecret := os.Getenv("FEISHU_APP_SECRET")
	if appID == "" || appSecret == "" {
		writeFeatureDisabled(w, "feishu_login_not_configured", "Feishu login is not configured")
		return
	}

	redirectURI := req.RedirectURI
	if redirectURI == "" {
		redirectURI = os.Getenv("FEISHU_REDIRECT_URI")
	}

	// Exchange authorization code for a user access token.
	tokenPayload, err := json.Marshal(map[string]string{
		"grant_type":    "authorization_code",
		"client_id":     appID,
		"client_secret": appSecret,
		"code":          req.Code,
		"redirect_uri":  redirectURI,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	tokenReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, feishuOAuthTokenURL, bytes.NewReader(tokenPayload))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	tokenReq.Header.Set("Content-Type", "application/json; charset=utf-8")

	tokenResp, err := h.feishuHTTPClient().Do(tokenReq)
	if err != nil {
		slog.Error("feishu oauth token exchange failed", "error", err)
		writeError(w, http.StatusBadGateway, "failed to exchange code with Feishu")
		return
	}
	defer tokenResp.Body.Close()

	tokenBody, err := io.ReadAll(io.LimitReader(tokenResp.Body, 1<<20))
	if err != nil {
		writeError(w, http.StatusBadGateway, "failed to read Feishu token response")
		return
	}

	var fToken feishuTokenResponse
	decodeErr := json.Unmarshal(tokenBody, &fToken)

	if tokenResp.StatusCode != http.StatusOK || decodeErr != nil || fToken.Code != 0 {
		slog.Error("feishu oauth token exchange returned error", "status", tokenResp.StatusCode, "body", string(tokenBody))
		// Only a well-formed invalid_grant response identifies a rejected or
		// expired authorization code. Everything else is a provider or
		// configuration failure.
		if decodeErr == nil && tokenResp.StatusCode == http.StatusBadRequest && fToken.Error == "invalid_grant" {
			writeErrorCode(w, http.StatusBadRequest, googleLoginCodeInvalidOAuthCode, "failed to exchange code with Feishu")
			return
		}
		writeError(w, http.StatusBadGateway, "failed to exchange code with Feishu")
		return
	}

	if strings.TrimSpace(fToken.AccessToken) == "" {
		slog.Error("feishu oauth token response has no access token")
		writeError(w, http.StatusBadGateway, "invalid Feishu token response")
		return
	}

	// Fetch the user profile with the user access token.
	userInfoReq, err := http.NewRequestWithContext(r.Context(), http.MethodGet, feishuUserInfoURL, nil)
	if err != nil {
		slog.Error("failed to create feishu userinfo request", "error", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	userInfoReq.Header.Set("Authorization", "Bearer "+fToken.AccessToken)

	userInfoResp, err := h.feishuHTTPClient().Do(userInfoReq)
	if err != nil {
		slog.Error("feishu userinfo fetch failed", "error", err)
		writeError(w, http.StatusBadGateway, "failed to fetch user info from Feishu")
		return
	}
	defer userInfoResp.Body.Close()

	userInfoBody, err := io.ReadAll(io.LimitReader(userInfoResp.Body, 1<<20))
	if err != nil {
		writeError(w, http.StatusBadGateway, "failed to fetch user info from Feishu")
		return
	}

	if userInfoResp.StatusCode != http.StatusOK {
		slog.Error("feishu userinfo returned error", "status", userInfoResp.StatusCode, "body", string(userInfoBody))
		writeError(w, http.StatusBadGateway, "failed to fetch user info from Feishu")
		return
	}

	var fUser feishuUserInfoResponse
	if err := json.Unmarshal(userInfoBody, &fUser); err != nil {
		writeError(w, http.StatusBadGateway, "failed to parse Feishu user info")
		return
	}
	if fUser.Code != 0 || fUser.Data == nil {
		slog.Error("feishu userinfo returned application error", "code", fUser.Code, "msg", fUser.Msg)
		writeError(w, http.StatusBadGateway, "failed to fetch user info from Feishu")
		return
	}

	// Multica accounts are keyed by email. Prefer the enterprise email; the
	// personal email field needs the same admin-granted scope and may be
	// empty for tenant members without one.
	email := strings.ToLower(strings.TrimSpace(fUser.Data.EnterpriseEmail))
	if email == "" {
		email = strings.ToLower(strings.TrimSpace(fUser.Data.Email))
	}

	// open_id is the stable identity across a Feishu app installation. Once it
	// is linked to a Multica user it takes precedence over email, so a person
	// without an enterprise mailbox can still return to the same account.
	openID := strings.ToLower(strings.TrimSpace(fUser.Data.OpenID))
	validOpenID := openID != ""
	for _, char := range openID {
		if (char < 'a' || char > 'z') && (char < '0' || char > '9') && char != '_' && char != '-' {
			validOpenID = false
			break
		}
	}
	if email == "" && !validOpenID {
		writeErrorCode(w, http.StatusBadRequest, feishuLoginCodeAccountWithoutEmail, "Feishu did not provide an email address or a valid Open ID for this sign-in")
		return
	}
	if email == "" {
		// The reserved .invalid TLD makes the fallback account identifier
		// explicitly non-routable. It remains a login alias, not an email claim.
		email = openID + "@feishu.invalid"
	}

	if auth.IsTemporarilyDisabledUserEmail(email) {
		writeErrorCode(w, http.StatusForbidden, googleLoginCodeAccountDisabled, auth.TemporarilyDisabledUserError)
		return
	}

	var user db.User
	var isNew bool
	if validOpenID {
		user, err = h.Queries.GetUserByFeishuOpenID(r.Context(), pgtype.Text{String: openID, Valid: true})
		if err != nil && !isNotFound(err) {
			slog.Warn("linked Feishu identity lookup failed", append(logger.RequestAttrs(r), "error", err)...)
			writeError(w, http.StatusInternalServerError, "failed to look up Feishu identity")
			return
		}
	}

	if !validOpenID || isNotFound(err) {
		user, isNew, err = h.findOrCreateUser(r.Context(), email)
		if err != nil {
			if writeGoogleLoginActionableError(w, err) {
				return
			}
			slog.Warn("login user lookup or creation failed", append(logger.RequestAttrs(r), "error", err, "email", email)...)
			writeError(w, http.StatusInternalServerError, "failed to create user")
			return
		}
		if validOpenID {
			user, err = h.Queries.SetUserFeishuOpenID(r.Context(), db.SetUserFeishuOpenIDParams{
				ID: user.ID, FeishuOpenID: pgtype.Text{String: openID, Valid: true},
			})
			if err != nil {
				slog.Warn("failed to link Feishu identity", append(logger.RequestAttrs(r), "error", err, "user_id", uuidToString(user.ID))...)
				writeError(w, http.StatusInternalServerError, "failed to link Feishu identity")
				return
			}
		}
	}
	if auth.IsTemporarilyDisabledUser(uuidToString(user.ID), user.Email) {
		writeErrorCode(w, http.StatusForbidden, googleLoginCodeAccountDisabled, auth.TemporarilyDisabledUserError)
		return
	}
	if isNew {
		evt := analytics.Signup(uuidToString(user.ID), user.Email, signupSourceFromRequest(r))
		evt.Properties["auth_method"] = "feishu"
		obsmetrics.RecordEvent(h.Analytics, h.Metrics, evt)
	}

	// Update name and avatar from the Feishu profile if the user was just
	// created (default name is the email prefix) or has no avatar yet.
	needsUpdate := false
	newName := user.Name
	newAvatar := user.AvatarUrl

	if fUser.Data.Name != "" && user.Name == strings.Split(email, "@")[0] {
		newName = fUser.Data.Name
		needsUpdate = true
	}
	if fUser.Data.AvatarURL != "" && !user.AvatarUrl.Valid {
		newAvatar = pgtype.Text{String: fUser.Data.AvatarURL, Valid: true}
		needsUpdate = true
	}

	if needsUpdate {
		updated, err := h.Queries.UpdateUser(r.Context(), db.UpdateUserParams{
			ID:        user.ID,
			Name:      newName,
			AvatarUrl: newAvatar,
		})
		if err == nil {
			user = updated
		}
	}

	tokenString, err := h.issueJWT(user)
	if err != nil {
		if writeGoogleLoginActionableError(w, err) {
			return
		}
		slog.Warn("feishu login failed", append(logger.RequestAttrs(r), "error", err, "email", email)...)
		writeError(w, http.StatusInternalServerError, "failed to generate token")
		return
	}

	if err := auth.SetAuthCookies(w, tokenString); err != nil {
		slog.Warn("failed to set auth cookies", "error", err)
	}

	if h.CFSigner != nil {
		for _, cookie := range h.CFSigner.SignedCookies(time.Now().Add(72 * time.Hour)) {
			http.SetCookie(w, cookie)
		}
	}

	slog.Info("user logged in via feishu", append(logger.RequestAttrs(r), "user_id", uuidToString(user.ID), "email", user.Email)...)
	writeJSON(w, http.StatusOK, LoginResponse{
		Token: tokenString,
		User:  h.userToResponse(user),
	})
}
