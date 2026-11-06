package handler

import (
	"context"
	"errors"
	"log/slog"
	"os"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/integrations/lark"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Organization data sources stored in feishu_org_config.source.
const (
	feishuOrgSourceLoginApp     = "login_app"
	feishuOrgSourceInstallation = "installation"
)

var errFeishuOrgLoginAppNotConfigured = errors.New("feishu org: login app is not configured (FEISHU_APP_ID / FEISHU_APP_SECRET)")

// feishuOrgLoginAppDirectoryNamespace derives the directory key of the login
// app. The directory table is keyed by UUID; the login app has no
// channel_installation, so its key is a stable name-based UUID of its app_id.
var feishuOrgLoginAppDirectoryNamespace = uuid.MustParse("6f1d7d2e-3c55-4a5e-9b8f-2a8b4f1c0e71")

// feishuLoginApp returns the deployment's Feishu login app credentials. They
// come from the environment on every call and are never persisted.
func feishuLoginApp() (lark.InstallationCredentials, bool) {
	appID := os.Getenv("FEISHU_APP_ID")
	appSecret := os.Getenv("FEISHU_APP_SECRET")
	if appID == "" || appSecret == "" {
		return lark.InstallationCredentials{}, false
	}
	return lark.InstallationCredentials{AppID: appID, AppSecret: appSecret, Region: lark.RegionFeishu}, true
}

// FeishuLoginAppCredentials exposes the login app to server wiring outside
// the handler package, such as the Feishu inbox notifier.
func FeishuLoginAppCredentials() (lark.InstallationCredentials, bool) {
	return feishuLoginApp()
}

func feishuOrgLoginAppDirectoryKey(appID string) pgtype.UUID {
	return pgtype.UUID{Bytes: uuid.NewSHA1(feishuOrgLoginAppDirectoryNamespace, []byte("feishu-login-app:"+appID)), Valid: true}
}

func feishuOrgConfigSource(config db.FeishuOrgConfig) string {
	if config.Source == feishuOrgSourceLoginApp {
		return feishuOrgSourceLoginApp
	}
	return feishuOrgSourceInstallation
}

// feishuOrgDirectoryKey is the key of the shared directory a config reads:
// the installation id, or the login app's derived key.
func feishuOrgDirectoryKey(config db.FeishuOrgConfig) (pgtype.UUID, error) {
	if feishuOrgConfigSource(config) == feishuOrgSourceInstallation {
		return config.InstallationID, nil
	}
	loginApp, ok := feishuLoginApp()
	if !ok {
		return pgtype.UUID{}, errFeishuOrgLoginAppNotConfigured
	}
	return feishuOrgLoginAppDirectoryKey(loginApp.AppID), nil
}

// feishuOrgSourceCredentials resolves the credentials an unattended refresh
// fetches with. The installation path requires an active row; the login app
// path never reads channel_installation.
func (h *Handler) feishuOrgSourceCredentials(ctx context.Context, config db.FeishuOrgConfig) (lark.InstallationCredentials, pgtype.UUID, error) {
	if feishuOrgConfigSource(config) == feishuOrgSourceLoginApp {
		loginApp, ok := feishuLoginApp()
		if !ok {
			return lark.InstallationCredentials{}, pgtype.UUID{}, errFeishuOrgLoginAppNotConfigured
		}
		return loginApp, feishuOrgLoginAppDirectoryKey(loginApp.AppID), nil
	}
	if h.LarkInstallations == nil {
		return lark.InstallationCredentials{}, pgtype.UUID{}, errors.New("feishu org: lark integration not configured")
	}
	installation, err := h.LarkInstallations.Get(ctx, config.InstallationID)
	if err != nil {
		return lark.InstallationCredentials{}, pgtype.UUID{}, err
	}
	if lark.InstallationStatus(installation.Status) != lark.InstallationActive {
		return lark.InstallationCredentials{}, pgtype.UUID{}, errors.New("feishu org: installation is not active")
	}
	secret, err := h.LarkInstallations.DecryptAppSecret(installation)
	if err != nil {
		return lark.InstallationCredentials{}, pgtype.UUID{}, err
	}
	return lark.InstallationCredentials{
		AppID: installation.AppID, AppSecret: secret, TenantKey: installation.TenantKey.String, Region: lark.Region(installation.Region),
	}, installation.ID, nil
}

// SwitchFeishuOrgSourcesToLoginApp runs once at startup. A config whose
// installation is the login app itself, or has been revoked, reads from the
// login app instead. Without a configured login app it does nothing.
func (h *Handler) SwitchFeishuOrgSourcesToLoginApp(ctx context.Context) error {
	loginApp, ok := feishuLoginApp()
	if !ok {
		return nil
	}
	rows, err := h.Queries.SwitchFeishuOrgConfigsToLoginApp(ctx, loginApp.AppID)
	if err != nil {
		return err
	}
	for _, row := range rows {
		slog.Info("feishu org: organization source switched to the login app",
			"workspace_id", uuidToString(row.WorkspaceID), "previous_installation_id", uuidToString(row.PreviousInstallationID))
	}
	return nil
}
