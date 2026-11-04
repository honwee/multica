package scheduler

import (
	"context"
	"fmt"
	"time"
)

// JobNameFeishuOrgSync refreshes Feishu organization directories and applies
// automatic organization sync for workspaces that opted in.
const JobNameFeishuOrgSync = "feishu_org_sync"

// FeishuOrgSyncer is the handler-side service the job delegates to. It
// returns how many workspaces were applied.
type FeishuOrgSyncer interface {
	SyncFeishuOrganizations(ctx context.Context) (int, error)
}

// FeishuOrgSyncJob runs hourly. Contact events from the Lark connector drive
// the same service between ticks; this job is the floor for tenants whose
// app has no event subscription.
func FeishuOrgSyncJob(syncer FeishuOrgSyncer) JobSpec {
	return JobSpec{
		Name:              JobNameFeishuOrgSync,
		Cadence:           time.Hour,
		ScheduleDelay:     2 * time.Minute,
		CatchUpMode:       CatchUpLatestOnly,
		CatchUpWindow:     24 * time.Hour,
		RunTimeout:        20 * time.Minute,
		StaleTimeout:      25 * time.Minute,
		HeartbeatInterval: 30 * time.Second,
		AllowStaleReentry: true,
		MaxAttempts:       2,
		RetryBackoff:      []time.Duration{5 * time.Minute},
		Scopes:            StaticScopes(ScopeGlobal),
		Handler: func(ctx context.Context, in HandlerInput) (HandlerResult, error) {
			applied, err := syncer.SyncFeishuOrganizations(ctx)
			result := HandlerResult{RowsAffected: int64(applied), Result: map[string]any{"applied": applied}}
			if err != nil {
				return result, fmt.Errorf("feishu org sync: %w", err)
			}
			return result, nil
		},
	}
}
