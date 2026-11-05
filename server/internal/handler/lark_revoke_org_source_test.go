package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRevokeLarkInstallationKeepsOrganizationSourceActive(t *testing.T) {
	fixture := newFeishuOrgHandlerFixture(t)
	if w := saveFeishuOrgConfig(t, fixture, fixture.ownerID, true, nil); w.Code != http.StatusOK {
		t.Fatalf("save status = %d, body=%s", w.Code, w.Body.String())
	}
	req := newRequestAs(fixture.ownerID, http.MethodDelete, "/api/workspaces/"+fixture.workspaceID+"/lark/installations/"+fixture.installationID, nil)
	req = withURLParams(req, "id", fixture.workspaceID, "installationId", fixture.installationID)
	w := httptest.NewRecorder()
	testHandler.RevokeLarkInstallation(w, req)
	if w.Code != http.StatusNoContent {
		t.Fatalf("revoke status = %d, body=%s", w.Code, w.Body.String())
	}
	var status string
	var agentBound, botOpenID bool
	if err := testPool.QueryRow(context.Background(),
		`SELECT status, agent_id IS NOT NULL, config ? 'bot_open_id' FROM channel_installation WHERE id = $1`, fixture.installationID,
	).Scan(&status, &agentBound, &botOpenID); err != nil {
		t.Fatalf("load installation: %v", err)
	}
	if status != "active" || agentBound || botOpenID {
		t.Fatalf("installation status=%s agent_bound=%v bot_open_id=%v, want an active agent-less connection", status, agentBound, botOpenID)
	}

	// Once nothing reads organization data from it, unbinding revokes.
	if _, err := testPool.Exec(context.Background(), `DELETE FROM feishu_org_config WHERE workspace_id = $1`, fixture.workspaceID); err != nil {
		t.Fatalf("clear config: %v", err)
	}
	if _, err := testPool.Exec(context.Background(), `UPDATE channel_installation SET agent_id = $2 WHERE id = $1`, fixture.installationID, fixture.agentID); err != nil {
		t.Fatalf("rebind agent: %v", err)
	}
	w = httptest.NewRecorder()
	testHandler.RevokeLarkInstallation(w, req)
	if w.Code != http.StatusNoContent {
		t.Fatalf("second revoke status = %d, body=%s", w.Code, w.Body.String())
	}
	if err := testPool.QueryRow(context.Background(), `SELECT status FROM channel_installation WHERE id = $1`, fixture.installationID).Scan(&status); err != nil {
		t.Fatalf("load installation: %v", err)
	}
	if status != "revoked" {
		t.Fatalf("status = %s, want revoked", status)
	}
}
