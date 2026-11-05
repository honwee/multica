package handler

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/integrations/lark"
)

// A burst of contact events for one installation collapses into a single
// refresh; a different installation gets its own.
func TestFeishuOrgContactSyncCoalescesEventsPerInstallation(t *testing.T) {
	var mu sync.Mutex
	calls := make(map[string]int)
	done := make(chan struct{}, 4)
	sink := &FeishuOrgContactSync{delay: 20 * time.Millisecond, pending: make(map[string]*time.Timer)}
	sink.sync = func(_ context.Context, installation lark.Installation) error {
		mu.Lock()
		calls[uuidToString(installation.ID)]++
		mu.Unlock()
		done <- struct{}{}
		return nil
	}
	first := lark.Installation{ID: parseUUID("11111111-1111-1111-1111-111111111111")}
	second := lark.Installation{ID: parseUUID("22222222-2222-2222-2222-222222222222")}
	for i := 0; i < 5; i++ {
		sink.NotifyContactChange(context.Background(), first, "contact.user.updated_v3")
	}
	sink.NotifyContactChange(context.Background(), second, "contact.department.created_v3")

	deadline := time.After(2 * time.Second)
	for received := 0; received < 2; {
		select {
		case <-done:
			received++
		case <-deadline:
			t.Fatal("timed out waiting for the coalesced refreshes")
		}
	}
	time.Sleep(50 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if calls[uuidToString(first.ID)] != 1 || calls[uuidToString(second.ID)] != 1 {
		t.Fatalf("refresh calls = %v, want exactly one per installation", calls)
	}
}
