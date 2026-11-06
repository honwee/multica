package main

import (
	"log/slog"
	"os"
	"strings"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/feishunotify"
	"github.com/multica-ai/multica/server/internal/handler"
	"github.com/multica-ai/multica/server/internal/integrations/lark"
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
		AppURL:      appURLFromEnv(),
	})
	notifier.Register(bus)
	slog.Info("feishu inbox notifications enabled")
	return notifier
}
