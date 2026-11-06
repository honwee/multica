package main

import (
	"log/slog"
	"os"
	"strings"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/feishunotify"
	"github.com/multica-ai/multica/server/internal/handler"
	"github.com/multica-ai/multica/server/internal/integrations/lark"
	"github.com/multica-ai/multica/server/internal/util/secretbox"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// registerFeishuNotifier subscribes the Feishu inbox notifier when the login
// app is configured. It returns nil otherwise; the caller starts Run.
func registerFeishuNotifier(bus *events.Bus, queries *db.Queries) *feishunotify.Notifier {
	creds, ok := handler.FeishuLoginAppCredentials()
	if !ok {
		return nil
	}
	sender := lark.NewDirectMessenger(lark.HTTPClientConfig{
		BaseURL: strings.TrimSpace(os.Getenv("MULTICA_LARK_HTTP_BASE_URL")),
		Logger:  slog.Default(),
	})
	notifier := feishunotify.New(queries, sender, feishunotify.Config{
		Credentials: creds,
		Bots:        feishuAgentBotRouter(queries),
		AppURL:      appURLFromEnv(),
	})
	notifier.Register(bus)
	slog.Info("feishu inbox notifications enabled")
	return notifier
}

// feishuAgentBotRouter lets agent bots send notifications when the Lark
// integration can decrypt their credentials. Nil keeps every notification on
// the login app.
func feishuAgentBotRouter(queries *db.Queries) feishunotify.BotRouter {
	key, err := secretbox.LoadKey("MULTICA_LARK_SECRET_KEY")
	if err != nil {
		return nil
	}
	box, err := secretbox.New(key)
	if err != nil {
		slog.Warn("feishu notify: agent bots disabled", "error", err)
		return nil
	}
	installs, err := lark.NewInstallationService(queries, box)
	if err != nil {
		slog.Warn("feishu notify: agent bots disabled", "error", err)
		return nil
	}
	return lark.NewAgentBotRouter(lark.NewChannelStore(queries), installs)
}
