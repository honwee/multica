package main

import (
	"log/slog"
	"os"
	"strings"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/feishunotify"
	"github.com/multica-ai/multica/server/internal/integrations/lark"
	"github.com/multica-ai/multica/server/internal/util/secretbox"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// registerFeishuNotifier subscribes the Feishu inbox notifier when agent bots
// can send. Only agent bots push notifications; the Feishu login app is left
// to sign-in and organization sync. It returns nil when agent bots are
// unavailable; the caller starts Run.
func registerFeishuNotifier(bus *events.Bus, queries *db.Queries) *feishunotify.Notifier {
	bots := feishuAgentBotRouter(queries)
	if bots == nil {
		return nil
	}
	sender := lark.NewDirectMessenger(lark.HTTPClientConfig{
		BaseURL: strings.TrimSpace(os.Getenv("MULTICA_LARK_HTTP_BASE_URL")),
		Logger:  slog.Default(),
	})
	notifier := feishunotify.New(queries, sender, feishunotify.Config{
		Bots:   bots,
		AppURL: appURLFromEnv(),
	})
	notifier.Register(bus)
	slog.Info("feishu inbox notifications enabled (agent bots only)")
	return notifier
}

// feishuAgentBotRouter lets agent bots send notifications when the Lark
// integration can decrypt their credentials, or returns nil.
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
