package daemon

import (
	"context"
	"sort"
	"sync"
	"testing"
)

// allowlistFixture wires a mutable allowlist resolver into a batch fixture so a
// test can change the list between syncs, the way an edit to config.json does.
func allowlistFixture(t *testing.T) (*batchFixture, func(ids ...string)) {
	t.Helper()
	fx := newBatchFixture(t)
	fx.daemon.cfg.Agents = map[string]AgentEntry{"codex": {Path: "/fake/codex"}}
	stubAgentProbe(t, map[string]AgentEntry{"codex": {Path: "/fake/codex"}})
	fx.setWorkspaces(
		WorkspaceInfo{ID: "ws-a", Name: "A"},
		WorkspaceInfo{ID: "ws-b", Name: "B"},
	)
	var (
		mu      sync.Mutex
		current []string
	)
	fx.daemon.cfg.WorkspaceAllowlist = func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), current...)
	}
	return fx, func(ids ...string) {
		mu.Lock()
		defer mu.Unlock()
		current = ids
	}
}

func trackedWorkspaceIDs(d *Daemon) []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := make([]string, 0, len(d.workspaces))
	for id := range d.workspaces {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

func syncOnce(t *testing.T, d *Daemon) {
	t.Helper()
	if err := d.syncWorkspacesFromAPI(context.Background(), false); err != nil {
		t.Fatalf("syncWorkspacesFromAPI: %v", err)
	}
}

func TestWorkspaceAllowlist_EmptyRegistersEveryWorkspace(t *testing.T) {
	fx, _ := allowlistFixture(t)
	syncOnce(t, fx.daemon)

	if got := trackedWorkspaceIDs(fx.daemon); len(got) != 2 {
		t.Fatalf("tracked = %v, want [ws-a ws-b]", got)
	}
	if n := fx.deregisteredCount(); n != 0 {
		t.Errorf("deregistered %d runtimes, want 0", n)
	}
}

func TestWorkspaceAllowlist_OnlyListedWorkspaceRegisters(t *testing.T) {
	fx, setAllowlist := allowlistFixture(t)
	setAllowlist("ws-a")
	syncOnce(t, fx.daemon)

	if got := trackedWorkspaceIDs(fx.daemon); len(got) != 1 || got[0] != "ws-a" {
		t.Fatalf("tracked = %v, want [ws-a]", got)
	}
	if ids, _ := fx.registrationFor("ws-b"); len(ids) != 0 {
		t.Errorf("ws-b registered %v, want nothing", ids)
	}
	if got := registeredProviders(t, fx.daemon, "ws-a"); len(got) != 1 || got[0] != "codex" {
		t.Errorf("ws-a providers = %v, want [codex]", got)
	}
}

func TestWorkspaceAllowlist_ChangeAppliesOnNextSync(t *testing.T) {
	fx, setAllowlist := allowlistFixture(t)
	syncOnce(t, fx.daemon)
	d := fx.daemon

	d.mu.Lock()
	bRuntimes := append([]string(nil), d.workspaces["ws-b"].runtimeIDs...)
	d.mu.Unlock()
	if len(bRuntimes) == 0 {
		t.Fatal("ws-b has no runtimes before the allowlist change")
	}

	setAllowlist("ws-a")
	syncOnce(t, d)

	if got := trackedWorkspaceIDs(d); len(got) != 1 || got[0] != "ws-a" {
		t.Fatalf("tracked after narrowing = %v, want [ws-a]", got)
	}
	deregistered := make(map[string]bool)
	for _, id := range fx.deregisteredIDs() {
		deregistered[id] = true
	}
	for _, id := range bRuntimes {
		if !deregistered[id] {
			t.Errorf("ws-b runtime %s was not deregistered", id)
		}
		if fx.runtimeOnline(id) {
			t.Errorf("ws-b runtime %s still online on the server", id)
		}
	}
	for _, id := range d.allRuntimeIDs() {
		if deregistered[id] {
			t.Errorf("ws-a runtime %s was deregistered", id)
		}
	}

	// Clearing the list brings ws-b back on the following sync.
	setAllowlist()
	syncOnce(t, d)
	if got := trackedWorkspaceIDs(d); len(got) != 2 {
		t.Errorf("tracked after clearing = %v, want [ws-a ws-b]", got)
	}
}

func TestWorkspaceAllowlist_NoMatchIsNotAStartupFailure(t *testing.T) {
	fx, setAllowlist := allowlistFixture(t)
	setAllowlist("ws-gone")
	syncOnce(t, fx.daemon)
	if got := trackedWorkspaceIDs(fx.daemon); len(got) != 0 {
		t.Errorf("tracked = %v, want none", got)
	}
}
