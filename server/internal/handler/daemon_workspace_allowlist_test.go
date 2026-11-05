package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

// registerAndReadMetadata registers one runtime with the given extra payload
// fields and returns the stored runtime metadata.
func registerAndReadMetadata(t *testing.T, daemonID string, extra map[string]any) map[string]any {
	t.Helper()
	body := map[string]any{
		"workspace_id": testWorkspaceID,
		"daemon_id":    daemonID,
		"device_name":  "allowlist-device",
		"runtimes": []map[string]any{
			{"name": "allowlist-runtime", "type": "claude", "version": "1.0.0", "status": "online"},
		},
	}
	for k, v := range extra {
		body[k] = v
	}
	req := newDaemonTokenRequest("POST", "/api/daemon/register", body, testWorkspaceID, daemonID)
	w := testutil.Call(t, testHandler.DaemonRegister, req).Want(http.StatusOK)

	var resp struct {
		Runtimes []struct {
			ID string `json:"id"`
		} `json:"runtimes"`
	}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil || len(resp.Runtimes) == 0 {
		t.Fatalf("DaemonRegister: decode runtimes: %v (%d runtimes)", err, len(resp.Runtimes))
	}
	runtimeID := resp.Runtimes[0].ID
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM agent_runtime WHERE id = $1`, runtimeID)
	})

	var raw []byte
	if err := testPool.QueryRow(context.Background(),
		`SELECT metadata FROM agent_runtime WHERE id = $1`, runtimeID).Scan(&raw); err != nil {
		t.Fatalf("read metadata: %v", err)
	}
	var metadata map[string]any
	if err := json.Unmarshal(raw, &metadata); err != nil {
		t.Fatalf("decode metadata: %v", err)
	}
	return metadata
}

func TestDaemonRegister_StoresWorkspaceAllowlist(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	metadata := registerAndReadMetadata(t, "test-daemon-allowlist", map[string]any{
		"workspace_allowlist": []string{testWorkspaceID, "ws-other"},
	})
	got, ok := metadata["workspace_allowlist"].([]any)
	if !ok || !reflect.DeepEqual(got, []any{testWorkspaceID, "ws-other"}) {
		t.Fatalf("workspace_allowlist = %#v, want [%s ws-other]", metadata["workspace_allowlist"], testWorkspaceID)
	}
}

func TestDaemonRegister_EmptyWorkspaceAllowlistMeansAll(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	metadata := registerAndReadMetadata(t, "test-daemon-allowlist-all", map[string]any{
		"workspace_allowlist": []string{},
	})
	got, ok := metadata["workspace_allowlist"].([]any)
	if !ok || len(got) != 0 {
		t.Fatalf("workspace_allowlist = %#v, want []", metadata["workspace_allowlist"])
	}
}

func TestDaemonRegister_OmitsWorkspaceAllowlistFromOlderDaemons(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	metadata := registerAndReadMetadata(t, "test-daemon-allowlist-legacy", nil)
	if _, present := metadata["workspace_allowlist"]; present {
		t.Fatalf("workspace_allowlist present for a daemon that did not send it: %#v", metadata)
	}
}
