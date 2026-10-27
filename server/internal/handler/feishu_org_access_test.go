package handler

import (
	"context"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/integrations/lark"
	"github.com/multica-ai/multica/server/internal/service"
)

func TestFeishuOrgTeamAccessControlsViewAssignAndInvoke(t *testing.T) {
	fixture := newFeishuOrgHandlerFixture(t)
	outsiderID := dbfx.User(t, "Feishu org outsider", "feishu-org-outsider-"+fixture.workspaceID+"@example.com")
	dbfx.Member(t, fixture.workspaceID, outsiderID, "member")
	mapping := LarkOrganizationMappingResponse{
		Kind: "department", ExternalID: "d1", ExternalName: "Engineering", AgentIDs: []string{fixture.agentID},
	}
	if w := saveFeishuOrgConfig(t, fixture, fixture.ownerID, true, []LarkOrganizationMappingResponse{mapping}); w.Code != http.StatusOK {
		t.Fatalf("save status = %d, body=%s", w.Code, w.Body.String())
	}
	client := newFakeFeishuOrgAPIClient()
	client.snapshot = lark.OrgSnapshot{
		Complete: true, Departments: []lark.OrgDepartment{{ID: "d1", Name: "Engineering"}},
		Users: []lark.OrgUser{{OpenID: "ou_member", Email: fixture.memberEmail, DepartmentIDs: []string{"d1"}, Active: true}},
	}
	wireFeishuOrgAPIClient(t, client)
	preview := previewFeishuOrg(t, fixture)
	if preview.Code != http.StatusOK {
		t.Fatalf("preview status = %d, body=%s", preview.Code, preview.Body.String())
	}
	previewRun := decodeFeishuOrgRun(t, preview)
	if applied := applyFeishuOrg(t, fixture, previewRun.ID); applied.Code != http.StatusOK {
		t.Fatalf("apply status = %d, body=%s", applied.Code, applied.Body.String())
	}

	ctx := context.Background()
	agent, err := testHandler.Queries.GetAgent(ctx, parseUUID(fixture.agentID))
	if err != nil {
		t.Fatalf("load agent: %v", err)
	}
	assertAccess := func(want bool) {
		t.Helper()
		if got := testHandler.canInvokeAgent(ctx, agent, "member", fixture.memberID, fixture.memberID, fixture.workspaceID); got != want {
			t.Errorf("canInvokeAgent = %v, want %v", got, want)
		}
		if got := testHandler.canAccessPrivateAgent(ctx, agent, "member", fixture.memberID, fixture.workspaceID); got != want {
			t.Errorf("canAccessPrivateAgent = %v, want %v", got, want)
		}
		if got := service.CanMemberInvokeAgent(ctx, testHandler.Queries, agent, parseUUID(fixture.memberID), parseUUID(fixture.workspaceID)); got != want {
			t.Errorf("service.CanMemberInvokeAgent = %v, want %v", got, want)
		}
		req := feishuOrgRequest(fixture.memberID, http.MethodPost, fixture.workspaceID, "/api/issues", nil)
		status, _ := testHandler.validateAssigneePair(ctx, req, fixture.workspaceID, pgtype.Text{String: "agent", Valid: true}, parseUUID(fixture.agentID))
		if got := status == 0; got != want {
			t.Errorf("assignment allowed = %v, want %v (status %d)", got, want, status)
		}
	}
	assertAccess(true)
	if testHandler.canInvokeAgent(ctx, agent, "member", outsiderID, outsiderID, fixture.workspaceID) {
		t.Fatal("organization grant admitted an outsider")
	}
	if testHandler.canInvokeAgent(ctx, agent, "system", "", "", fixture.workspaceID) {
		t.Fatal("organization grant admitted a system trigger without a human originator")
	}

	dbfx.Exec(t, `UPDATE feishu_org_membership SET active = false WHERE workspace_id = $1 AND user_id = $2`, fixture.workspaceID, fixture.memberID)
	assertAccess(false)
	dbfx.Exec(t, `UPDATE feishu_org_membership SET active = true WHERE workspace_id = $1 AND user_id = $2`, fixture.workspaceID, fixture.memberID)
	dbfx.Exec(t, `UPDATE member SET disabled_at = now() WHERE workspace_id = $1 AND user_id = $2`, fixture.workspaceID, fixture.memberID)
	assertAccess(false)
	var targetCount int
	if err := testPool.QueryRow(ctx, `SELECT count(*) FROM agent_invocation_target WHERE agent_id = $1 AND target_type = 'team'`, fixture.agentID).Scan(&targetCount); err != nil {
		t.Fatalf("count team targets: %v", err)
	}
	if targetCount != 1 {
		t.Fatalf("team target count = %d, want 1", targetCount)
	}
	var memberRole string
	if err := testPool.QueryRow(ctx, `SELECT role FROM member WHERE workspace_id = $1 AND user_id = $2`, fixture.workspaceID, fixture.memberID).Scan(&memberRole); err != nil {
		t.Fatalf("load disabled member: %v", err)
	}
	if memberRole != "member" {
		t.Fatalf("disabled member role = %q, want member", memberRole)
	}
}

func TestFeishuOrgDisabledOwnerCannotBypassMembership(t *testing.T) {
	fixture := newFeishuOrgHandlerFixture(t)
	ctx := context.Background()
	agent, err := testHandler.Queries.GetAgent(ctx, parseUUID(fixture.agentID))
	if err != nil {
		t.Fatalf("load agent: %v", err)
	}
	dbfx.Exec(t, `UPDATE member SET disabled_at = now() WHERE workspace_id = $1 AND user_id = $2`, fixture.workspaceID, fixture.ownerID)
	if testHandler.canInvokeAgent(ctx, agent, "member", fixture.ownerID, fixture.ownerID, fixture.workspaceID) {
		t.Fatal("disabled owner could invoke their agent")
	}
	if testHandler.canAccessPrivateAgent(ctx, agent, "member", fixture.ownerID, fixture.workspaceID) {
		t.Fatal("disabled owner could view their agent")
	}
	if service.CanMemberInvokeAgent(ctx, testHandler.Queries, agent, parseUUID(fixture.ownerID), parseUUID(fixture.workspaceID)) {
		t.Fatal("disabled owner could invoke through the durable-trigger gate")
	}
}
