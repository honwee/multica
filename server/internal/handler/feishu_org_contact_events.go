package handler

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/multica-ai/multica/server/internal/integrations/lark"
)

// feishuOrgContactEventDelay coalesces the burst of contact events a single
// HR change produces (one per user and department) into one directory
// refresh.
const feishuOrgContactEventDelay = 30 * time.Second

// FeishuOrgContactSync turns Feishu contact events into debounced directory
// refreshes and automatic syncs for the installation they arrived on. One
// timer per installation; a new event while a timer is pending resets it.
type FeishuOrgContactSync struct {
	handler *Handler
	delay   time.Duration
	mu      sync.Mutex
	pending map[string]*time.Timer
	// sync is swapped in tests; it defaults to the handler's installation sync.
	sync func(ctx context.Context, installation lark.Installation) error
}

// NewFeishuOrgContactSync builds the sink the Lark connector reports contact
// events to.
func NewFeishuOrgContactSync(h *Handler) *FeishuOrgContactSync {
	s := &FeishuOrgContactSync{handler: h, delay: feishuOrgContactEventDelay, pending: make(map[string]*time.Timer)}
	s.sync = h.SyncFeishuOrganizationInstallation
	return s
}

var _ lark.ContactEventSink = (*FeishuOrgContactSync)(nil)

// NotifyContactChange schedules a refresh for the installation. It returns
// immediately: the connector ACKs the frame right after, and the refresh
// runs on its own goroutine with a bounded context.
func (s *FeishuOrgContactSync) NotifyContactChange(_ context.Context, inst lark.Installation, eventType string) {
	key := uuidToString(inst.ID)
	s.mu.Lock()
	defer s.mu.Unlock()
	// Reset reports false once the timer has fired; its callback is then
	// about to run (or waiting on this lock), so a fresh timer is needed and
	// the old callback must not remove it from pending.
	if timer, ok := s.pending[key]; ok && timer.Reset(s.delay) {
		return
	}
	slog.Debug("feishu org: contact event scheduled a directory refresh", "installation_id", key, "event_type", eventType)
	var timer *time.Timer
	timer = time.AfterFunc(s.delay, func() {
		s.mu.Lock()
		if s.pending[key] == timer {
			delete(s.pending, key)
		}
		s.mu.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		if err := s.sync(ctx, inst); err != nil {
			slog.Warn("feishu org: event-driven sync failed", "installation_id", key, "error", err)
		}
	})
	s.pending[key] = timer
}
