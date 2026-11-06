package lark

import (
	"context"
	"log/slog"
	"time"
)

// BackfillBotUnionIDs walks every active lark_installation row whose
// bot_union_id is NULL and calls APIClient.GetBotInfo to capture and
// persist it. This is the migration glue for installations created
// before migration 112 added the column — see MUL-2671 group @-mention
// triage. New installs already write bot_union_id during the device-
// flow finalize, so this is a one-shot bridge, not an ongoing job.
//
// Behavior:
//
//   - The function is best-effort and per-installation idempotent:
//     a transient HTTP / decrypt / DB error on one row does not block
//     subsequent rows or interrupt server startup. Every outcome is
//     logged with the installation id so an operator can audit
//     coverage after a deploy.
//
//   - Soft-fails on union_id absence (Lark returns code=0 with empty
//     union_id when the app's contact scope is restricted, or the
//     contact lookup answers 41050 / 41012 because a bot is not a
//     directory user): we log at INFO and move on; the decoder's
//     open_id fallback keeps the install usable. Real lookup failures
//     are already WARNed inside GetBotInfo.
//
//   - Callers should fire this from a separate goroutine at boot so
//     a slow Lark round-trip cannot block HTTP listener startup. The
//     backfill respects ctx cancellation between rows.
//
// Schedule: the router invokes this once per process at boot. There
// is no reason to repeat it on a sweep cadence — once bot_union_id
// is non-NULL, the decoder uses it directly, and a re-install path
// already overwrites both identifiers via UpsertLarkInstallation.
func BackfillBotUnionIDs(
	ctx context.Context,
	queries unionIDBackfillStore,
	api APIClient,
	creds CredentialsDecrypter,
	log *slog.Logger,
) {
	if log == nil {
		log = slog.Default()
	}
	if api == nil || !api.IsConfigured() {
		log.Info("lark backfill: APIClient not configured; skipping union_id backfill")
		return
	}
	rows, err := queries.ListActiveLarkInstallations(ctx)
	if err != nil {
		log.Warn("lark backfill: list installations failed", "err", err)
		return
	}
	var attempted, filled, missed, errored int
	for _, row := range rows {
		if ctx.Err() != nil {
			return
		}
		if row.BotUnionID.Valid && row.BotUnionID.String != "" {
			continue
		}
		attempted++
		secret, err := creds.DecryptAppSecret(row)
		if err != nil {
			log.Warn("lark backfill: decrypt app_secret failed",
				"installation_id", uuidString(row.ID),
				"app_id", row.AppID,
				"err", err)
			errored++
			continue
		}
		// Bound the Lark round-trip so a single hung install row
		// does not pin the backfill goroutine. 10s matches the
		// http client's defaultRequestTimeout.
		fetchCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		info, err := api.GetBotInfo(fetchCtx, InstallationCredentials{
			AppID:     row.AppID,
			AppSecret: secret,
			TenantKey: row.TenantKey.String,
			Region:    RegionOrDefault(row.Region),
		})
		cancel()
		if err != nil {
			log.Warn("lark backfill: GetBotInfo failed",
				"installation_id", uuidString(row.ID),
				"app_id", row.AppID,
				"err", err)
			errored++
			continue
		}
		if info.UnionID == "" {
			log.Info("lark backfill: bot is outside contact scope; skipping union_id, group @-mention matching uses open_id",
				"installation_id", uuidString(row.ID),
				"app_id", row.AppID,
				"bot_open_id", string(info.OpenID))
			missed++
			continue
		}
		if err := queries.SetLarkInstallationBotUnionID(ctx, SetInstallationBotUnionIDParams{
			ID:         row.ID,
			BotUnionID: textOrNull(info.UnionID),
		}); err != nil {
			log.Warn("lark backfill: persist union_id failed",
				"installation_id", uuidString(row.ID),
				"err", err)
			errored++
			continue
		}
		filled++
		log.Info("lark backfill: stamped union_id",
			"installation_id", uuidString(row.ID),
			"app_id", row.AppID,
			"bot_open_id", string(info.OpenID))
	}
	log.Info("lark backfill: union_id pass complete",
		"attempted", attempted,
		"filled", filled,
		"missed", missed,
		"errored", errored)
}

// unionIDBackfillStore is the narrow DB surface BackfillBotUnionIDs
// needs; *ChannelStore satisfies it. Kept as an interface so the
// backfill loop can be unit-tested without a database.
type unionIDBackfillStore interface {
	ListActiveLarkInstallations(ctx context.Context) ([]Installation, error)
	SetLarkInstallationBotUnionID(ctx context.Context, arg SetInstallationBotUnionIDParams) error
}

// CredentialsDecrypter is the narrow surface BackfillBotUnionIDs needs
// from InstallationService. Defined here (rather than imported as a
// concrete *InstallationService) so the backfill can be unit-tested
// with a stub that returns canned plaintext without spinning up the
// secretbox machinery.
type CredentialsDecrypter interface {
	DecryptAppSecret(inst Installation) (string, error)
}
