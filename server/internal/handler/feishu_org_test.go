package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/integrations/lark"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util/secretbox"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type fakeFeishuOrgAPIClient struct {
	lark.APIClient
	snapshot    lark.OrgSnapshot
	err         error
	calls       int
	credentials lark.InstallationCredentials
}

func newFakeFeishuOrgAPIClient() *fakeFeishuOrgAPIClient {
	return &fakeFeishuOrgAPIClient{APIClient: lark.NewStubAPIClient(nil)}
}

func (f *fakeFeishuOrgAPIClient) FetchOrganization(_ context.Context, credentials lark.InstallationCredentials) (lark.OrgSnapshot, error) {
	f.calls++
	f.credentials = credentials
	return f.snapshot, f.err
}

type feishuOrgHandlerFixture struct {
	workspaceID    string
	ownerID        string
	adminID        string
	memberID       string
	memberEmail    string
	agentID        string
	installationID string
}

func newFeishuOrgHandlerFixture(t *testing.T) feishuOrgHandlerFixture {
	t.Helper()
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	token := uuid.NewString()
	workspaceID := dbfx.Workspace(t, "Feishu org "+token, "feishu-org-"+token)
	ownerID := testUserID
	dbfx.Member(t, workspaceID, ownerID, "owner")
	adminID := dbfx.User(t, "Feishu org admin", "feishu-org-admin-"+token+"@example.com")
	dbfx.Member(t, workspaceID, adminID, "admin")
	memberEmail := "feishu-org-member-" + token + "@example.com"
	memberID := dbfx.User(t, "Feishu org member", memberEmail)
	dbfx.Member(t, workspaceID, memberID, "member")
	agentID := dbfx.Agent(t, "Feishu org agent", "", testutil.Cols{"workspace_id": workspaceID, "owner_id": ownerID})
	dbfx.Cleanup(t, `DELETE FROM agent_invocation_target WHERE agent_id = $1`, agentID)
	t.Cleanup(func() {
		_, _ = testPool.Exec(context.Background(), `DELETE FROM feishu_org_sync_run WHERE workspace_id = $1`, workspaceID)
		_, _ = testPool.Exec(context.Background(), `DELETE FROM feishu_org_membership WHERE workspace_id = $1`, workspaceID)
		_, _ = testPool.Exec(context.Background(), `DELETE FROM feishu_org_agent_mapping WHERE workspace_id = $1`, workspaceID)
		_, _ = testPool.Exec(context.Background(), `DELETE FROM feishu_org_role_mapping WHERE workspace_id = $1`, workspaceID)
		_, _ = testPool.Exec(context.Background(), `DELETE FROM feishu_org_group WHERE workspace_id = $1`, workspaceID)
		_, _ = testPool.Exec(context.Background(), `DELETE FROM feishu_org_config WHERE workspace_id = $1`, workspaceID)
	})

	box, err := secretbox.New(make([]byte, secretbox.KeySize))
	if err != nil {
		t.Fatalf("secretbox.New: %v", err)
	}
	installations, err := lark.NewInstallationService(testHandler.Queries, box)
	if err != nil {
		t.Fatalf("NewInstallationService: %v", err)
	}
	installation, err := installations.Upsert(context.Background(), lark.InstallationParams{
		WorkspaceID: parseUUID(workspaceID), AgentID: parseUUID(agentID), AppID: "cli_feishu_org_test_" + token,
		AppSecret: "feishu-org-test-secret", BotOpenID: "ou_feishu_org_bot", InstallerUserID: parseUUID(ownerID),
	})
	if err != nil {
		t.Fatalf("create Lark installation: %v", err)
	}
	dbfx.Cleanup(t, `DELETE FROM channel_installation WHERE id = $1`, uuidToString(installation.ID))
	previousInstallations := testHandler.LarkInstallations
	testHandler.LarkInstallations = installations
	t.Cleanup(func() { testHandler.LarkInstallations = previousInstallations })

	return feishuOrgHandlerFixture{
		workspaceID: workspaceID, ownerID: ownerID, adminID: adminID, memberID: memberID,
		memberEmail: memberEmail, agentID: agentID, installationID: uuidToString(installation.ID),
	}
}

func feishuOrgRole(role string) *string { return &role }

func feishuOrgRequest(userID, method, workspaceID, path string, body any, params ...string) *http.Request {
	req := newRequestAs(userID, method, path, body)
	req.Header.Set("X-Workspace-ID", workspaceID)
	params = append([]string{"id", workspaceID}, params...)
	return withURLParams(req, params...)
}

func saveFeishuOrgConfig(t *testing.T, fixture feishuOrgHandlerFixture, userID string, enabled bool, mappings []LarkOrganizationMappingResponse) *httptest.ResponseRecorder {
	t.Helper()
	req := feishuOrgRequest(userID, http.MethodPut, fixture.workspaceID, "/api/workspaces/"+fixture.workspaceID+"/lark/organization", UpdateLarkOrganizationRequest{
		InstallationID: fixture.installationID, Enabled: enabled, Mappings: mappings,
	})
	w := httptest.NewRecorder()
	testHandler.UpdateLarkOrganization(w, req)
	return w
}

func previewFeishuOrg(t *testing.T, fixture feishuOrgHandlerFixture) *httptest.ResponseRecorder {
	t.Helper()
	req := feishuOrgRequest(fixture.ownerID, http.MethodPost, fixture.workspaceID, "/api/workspaces/"+fixture.workspaceID+"/lark/organization/preview", nil)
	w := httptest.NewRecorder()
	testHandler.PreviewLarkOrganization(w, req)
	return w
}

func applyFeishuOrg(t *testing.T, fixture feishuOrgHandlerFixture, runID string) *httptest.ResponseRecorder {
	t.Helper()
	req := feishuOrgRequest(fixture.ownerID, http.MethodPost, fixture.workspaceID, "/api/workspaces/"+fixture.workspaceID+"/lark/organization/sync/"+runID+"/apply", nil, "runId", runID)
	w := httptest.NewRecorder()
	testHandler.ApplyLarkOrganizationSync(w, req)
	return w
}

func replayFeishuOrg(t *testing.T, fixture feishuOrgHandlerFixture, runID string) *httptest.ResponseRecorder {
	t.Helper()
	req := feishuOrgRequest(fixture.ownerID, http.MethodPost, fixture.workspaceID, "/api/workspaces/"+fixture.workspaceID+"/lark/organization/sync/"+runID+"/replay", nil, "runId", runID)
	w := httptest.NewRecorder()
	testHandler.ReplayLarkOrganizationSync(w, req)
	return w
}

func decodeFeishuOrgRun(t *testing.T, w *httptest.ResponseRecorder) LarkOrganizationSyncRunResponse {
	t.Helper()
	var run LarkOrganizationSyncRunResponse
	if err := json.Unmarshal(w.Body.Bytes(), &run); err != nil {
		t.Fatalf("decode sync run: %v; body=%s", err, w.Body.String())
	}
	return run
}

func wireFeishuOrgAPIClient(t *testing.T, client *fakeFeishuOrgAPIClient) {
	t.Helper()
	previous := testHandler.LarkAPIClient
	testHandler.LarkAPIClient = client
	t.Cleanup(func() { testHandler.LarkAPIClient = previous })
}

func TestFeishuOrgGetEmptyResponse(t *testing.T) {
	fixture := newFeishuOrgHandlerFixture(t)
	req := feishuOrgRequest(fixture.ownerID, http.MethodGet, fixture.workspaceID, "/api/workspaces/"+fixture.workspaceID+"/lark/organization", nil)
	w := httptest.NewRecorder()
	testHandler.GetLarkOrganization(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("GetLarkOrganization status = %d, body=%s", w.Code, w.Body.String())
	}
	var response LarkOrganizationResponse
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if response.Config != nil || response.Mappings == nil || response.SyncRuns == nil || response.Requirements == nil {
		t.Fatalf("unexpected empty response: %+v", response)
	}
	if len(response.RequiredScopes) != len(lark.RequiredOrgScopes) {
		t.Fatalf("required scopes = %v, want %v", response.RequiredScopes, lark.RequiredOrgScopes)
	}
}

func TestFeishuOrgGetRequiresAdmin(t *testing.T) {
	fixture := newFeishuOrgHandlerFixture(t)
	if w := saveFeishuOrgConfig(t, fixture, fixture.ownerID, true, nil); w.Code != http.StatusOK {
		t.Fatalf("save status = %d, body=%s", w.Code, w.Body.String())
	}
	tests := []struct {
		name   string
		userID string
		want   int
	}{
		{name: "owner", userID: fixture.ownerID, want: http.StatusOK},
		{name: "admin", userID: fixture.adminID, want: http.StatusOK},
		{name: "member", userID: fixture.memberID, want: http.StatusForbidden},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := feishuOrgRequest(tt.userID, http.MethodGet, fixture.workspaceID, "/api/workspaces/"+fixture.workspaceID+"/lark/organization", nil)
			w := httptest.NewRecorder()
			testHandler.GetLarkOrganization(w, req)
			if w.Code != tt.want {
				t.Fatalf("GetLarkOrganization status = %d, want %d; body=%s", w.Code, tt.want, w.Body.String())
			}
		})
	}
}

func TestFeishuOrgCatalogIncludesDirectoryAndWorkspaceMembers(t *testing.T) {
	fixture := newFeishuOrgHandlerFixture(t)
	if w := saveFeishuOrgConfig(t, fixture, fixture.ownerID, true, nil); w.Code != http.StatusOK {
		t.Fatalf("save status = %d, body=%s", w.Code, w.Body.String())
	}
	client := newFakeFeishuOrgAPIClient()
	client.snapshot = lark.OrgSnapshot{
		Complete:    true,
		Departments: []lark.OrgDepartment{{ID: "d1", Name: "Engineering"}, {ID: "d2", Name: "Support"}},
		Users: []lark.OrgUser{
			{OpenID: "ou_sensitive", UnionID: "on_sensitive", Email: fixture.memberEmail, Name: "Member", JobTitle: "Engineer", DepartmentIDs: []string{"d1"}, Active: true},
			{OpenID: "ou_other", UnionID: "on_other", Email: "other@example.com", Name: "Other", DepartmentIDs: []string{"d2"}, Active: false},
		},
	}
	wireFeishuOrgAPIClient(t, client)
	if preview := previewFeishuOrg(t, fixture); preview.Code != http.StatusOK {
		t.Fatalf("preview status = %d, body=%s", preview.Code, preview.Body.String())
	}
	req := feishuOrgRequest(fixture.ownerID, http.MethodGet, fixture.workspaceID, "/api/workspaces/"+fixture.workspaceID+"/lark/organization", nil)
	w := httptest.NewRecorder()
	testHandler.GetLarkOrganization(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("GetLarkOrganization status = %d, body=%s", w.Code, w.Body.String())
	}
	var response LarkOrganizationResponse
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	catalog := response.Catalog
	if catalog == nil {
		t.Fatal("catalog is missing")
	}
	if catalog.SnapshotAt == "" || catalog.TotalUsers != 2 || catalog.ActiveUsers != 1 || catalog.JobTitleUsers != 1 {
		t.Fatalf("unexpected catalog summary: %+v", catalog)
	}
	if len(catalog.Departments) != 2 || len(catalog.JobTitles) != 1 || catalog.JobTitles[0].Name != "Engineer" {
		t.Fatalf("unexpected catalog directory: %+v", catalog)
	}
	if len(catalog.WorkspaceMembers) != 3 {
		t.Fatalf("workspace members = %d, want 3", len(catalog.WorkspaceMembers))
	}
	var linked *LarkOrganizationWorkspaceMemberResponse
	for i := range catalog.WorkspaceMembers {
		if catalog.WorkspaceMembers[i].UserID == fixture.memberID {
			linked = &catalog.WorkspaceMembers[i]
		}
	}
	if linked == nil || !linked.Linked || linked.IdentityConflict || linked.JobTitle != "Engineer" || len(linked.Departments) != 1 || linked.Departments[0] != "Engineering" || linked.FeishuActive == nil || !*linked.FeishuActive {
		t.Fatalf("unexpected linked workspace member: %+v", linked)
	}
	if len(catalog.Users) != 2 {
		t.Fatalf("catalog users = %d, want 2", len(catalog.Users))
	}
	var directoryUser *LarkOrganizationUserResponse
	for i := range catalog.Users {
		if catalog.Users[i].UnionID == "on_sensitive" {
			directoryUser = &catalog.Users[i]
		}
	}
	if directoryUser == nil || !directoryUser.WorkspaceMember || directoryUser.JobTitle != "Engineer" {
		t.Fatalf("unexpected catalog user: %+v", directoryUser)
	}
	for _, sensitive := range []string{"ou_sensitive", fixture.memberEmail} {
		if strings.Contains(w.Body.String(), sensitive) {
			t.Fatalf("catalog leaked sensitive identity %q", sensitive)
		}
	}
}

func TestFeishuOrgSaveDoesNotApplyRolesOrAgentAccess(t *testing.T) {
	fixture := newFeishuOrgHandlerFixture(t)
	dbfx.Exec(t, `INSERT INTO agent_invocation_target (agent_id, target_type, target_id, created_by) VALUES ($1, 'member', $2, $3)`, fixture.agentID, fixture.adminID, fixture.ownerID)
	var initialPermissionMode string
	if err := testPool.QueryRow(context.Background(), `SELECT permission_mode FROM agent WHERE id = $1`, fixture.agentID).Scan(&initialPermissionMode); err != nil {
		t.Fatalf("load initial agent permission: %v", err)
	}
	mapping := LarkOrganizationMappingResponse{
		Kind: "department", ExternalID: "d1", ExternalName: "Engineering", MemberRole: feishuOrgRole("admin"), AgentIDs: []string{fixture.agentID},
	}
	w := saveFeishuOrgConfig(t, fixture, fixture.ownerID, true, []LarkOrganizationMappingResponse{mapping})
	if w.Code != http.StatusOK {
		t.Fatalf("save status = %d, body=%s", w.Code, w.Body.String())
	}
	var response LarkOrganizationResponse
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode save response: %v", err)
	}
	if response.Config == nil || !response.Config.Enabled || response.Config.Revision != 1 || len(response.Mappings) != 1 {
		t.Fatalf("unexpected save response: %+v", response)
	}
	if response.Mappings[0].MemberRole == nil || *response.Mappings[0].MemberRole != "admin" || len(response.Mappings[0].AgentIDs) != 1 {
		t.Fatalf("unexpected saved mapping: %+v", response.Mappings[0])
	}
	var role string
	var managedRole pgtype.Text
	if err := testPool.QueryRow(context.Background(), `SELECT role, feishu_managed_role FROM member WHERE workspace_id = $1 AND user_id = $2`, fixture.workspaceID, fixture.memberID).Scan(&role, &managedRole); err != nil {
		t.Fatalf("load member: %v", err)
	}
	if role != "member" || managedRole.Valid {
		t.Fatalf("save changed member access: role=%q managed_role=%+v", role, managedRole)
	}
	var permissionMode string
	if err := testPool.QueryRow(context.Background(), `SELECT permission_mode FROM agent WHERE id = $1`, fixture.agentID).Scan(&permissionMode); err != nil {
		t.Fatalf("load agent: %v", err)
	}
	if permissionMode != initialPermissionMode {
		t.Fatalf("save changed permission_mode from %q to %q before preview", initialPermissionMode, permissionMode)
	}
	if count := dbfx.Count(t, `SELECT count(*) FROM agent_invocation_target WHERE agent_id = $1 AND target_type = 'member' AND target_id = $2`, fixture.agentID, fixture.adminID); count != 1 {
		t.Fatal("save removed an unrelated member invocation target")
	}
	if count := dbfx.Count(t, `SELECT count(*) FROM agent_invocation_target WHERE agent_id = $1 AND target_type = 'team'`, fixture.agentID); count != 0 {
		t.Fatal("save created a team invocation target before preview")
	}
	if count := dbfx.Count(t, `SELECT count(*) FROM feishu_org_group WHERE workspace_id = $1 AND active`, fixture.workspaceID); count != 0 {
		t.Fatal("save activated the organization group before preview")
	}

	w = saveFeishuOrgConfig(t, fixture, fixture.ownerID, true, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("save removal status = %d, body=%s", w.Code, w.Body.String())
	}
	if count := dbfx.Count(t, `SELECT count(*) FROM agent_invocation_target WHERE agent_id = $1 AND target_type = 'member'`, fixture.agentID); count != 1 {
		t.Fatal("removing the mapping removed an unrelated member target")
	}
	if count := dbfx.Count(t, `SELECT count(*) FROM feishu_org_group WHERE workspace_id = $1 AND configured`, fixture.workspaceID); count != 0 {
		t.Fatal("removed mapping group is still configured")
	}
}

func TestFeishuOrgSaveUserMapping(t *testing.T) {
	fixture := newFeishuOrgHandlerFixture(t)
	mapping := LarkOrganizationMappingResponse{
		Kind: "user", ExternalID: "on_member", ExternalName: "Member",
		MemberRole: feishuOrgRole("admin"), AgentIDs: []string{fixture.agentID},
	}
	w := saveFeishuOrgConfig(t, fixture, fixture.ownerID, true, []LarkOrganizationMappingResponse{mapping})
	if w.Code != http.StatusOK {
		t.Fatalf("save user mapping status = %d, body=%s", w.Code, w.Body.String())
	}
	var response LarkOrganizationResponse
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode save response: %v", err)
	}
	if len(response.Mappings) != 1 || response.Mappings[0].Kind != "user" || response.Mappings[0].ExternalID != "on_member" {
		t.Fatalf("unexpected saved user mapping: %+v", response.Mappings)
	}
	var kind, externalID, role string
	if err := testPool.QueryRow(context.Background(), `SELECT g.kind, g.external_id, r.role FROM feishu_org_group g JOIN feishu_org_role_mapping r ON r.group_id = g.id WHERE g.workspace_id = $1 AND g.configured`, fixture.workspaceID).Scan(&kind, &externalID, &role); err != nil {
		t.Fatalf("load saved user mapping: %v", err)
	}
	if kind != "user" || externalID != "on_member" || role != "admin" {
		t.Fatalf("saved user mapping = %q %q %q", kind, externalID, role)
	}
}

func TestLarkWorkspaceConnectionWithoutAgent(t *testing.T) {
	fixture := newFeishuOrgHandlerFixture(t)
	appID := "cli_workspace_" + uuid.NewString()
	request := ConnectLarkWorkspaceConnectionRequest{AppID: appID, AppSecret: "workspace-secret", Region: "feishu"}
	memberReq := feishuOrgRequest(fixture.memberID, http.MethodPost, fixture.workspaceID, "/api/workspaces/"+fixture.workspaceID+"/lark/connections", request)
	memberWriter := httptest.NewRecorder()
	testHandler.ConnectLarkWorkspaceConnection(memberWriter, memberReq)
	if memberWriter.Code != http.StatusForbidden {
		t.Fatalf("member create app connection status = %d, want 403", memberWriter.Code)
	}

	req := feishuOrgRequest(fixture.ownerID, http.MethodPost, fixture.workspaceID, "/api/workspaces/"+fixture.workspaceID+"/lark/connections", request)
	w := httptest.NewRecorder()
	testHandler.ConnectLarkWorkspaceConnection(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("create app connection status = %d, body=%s", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), "workspace-secret") {
		t.Fatal("app connection response leaked the app secret")
	}
	var response LarkInstallationResponse
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode app connection: %v", err)
	}
	if response.AgentID != nil || response.AppID != appID {
		t.Fatalf("unexpected app connection: %+v", response)
	}
	dbfx.Cleanup(t, `DELETE FROM channel_installation WHERE id = $1`, response.ID)
	installation, err := testHandler.LarkInstallations.GetInWorkspace(context.Background(), parseUUID(response.ID), parseUUID(fixture.workspaceID))
	if err != nil || installation.AgentID.Valid {
		t.Fatalf("stored app connection = %+v, err=%v", installation, err)
	}
	secret, err := testHandler.LarkInstallations.DecryptAppSecret(installation)
	if err != nil || secret != "workspace-secret" {
		t.Fatalf("decrypt app connection secret: %v", err)
	}
	active, err := lark.NewChannelStore(testHandler.Queries).ListActiveLarkInstallations(context.Background())
	if err != nil {
		t.Fatalf("list active installations: %v", err)
	}
	for _, candidate := range active {
		if candidate.ID == installation.ID {
			t.Fatal("agent-less app connection must not start a Bot WebSocket")
		}
	}

	configReq := feishuOrgRequest(fixture.ownerID, http.MethodPut, fixture.workspaceID, "/api/workspaces/"+fixture.workspaceID+"/lark/organization", UpdateLarkOrganizationRequest{
		InstallationID: response.ID, Enabled: true, Mappings: []LarkOrganizationMappingResponse{},
	})
	configWriter := httptest.NewRecorder()
	testHandler.UpdateLarkOrganization(configWriter, configReq)
	if configWriter.Code != http.StatusOK {
		t.Fatalf("save organization config status = %d, body=%s", configWriter.Code, configWriter.Body.String())
	}
	client := newFakeFeishuOrgAPIClient()
	client.snapshot = lark.OrgSnapshot{Complete: true}
	wireFeishuOrgAPIClient(t, client)
	if preview := previewFeishuOrg(t, fixture); preview.Code != http.StatusOK {
		t.Fatalf("preview with agent-less app status = %d, body=%s", preview.Code, preview.Body.String())
	}
	if client.calls != 1 {
		t.Fatalf("organization fetches = %d, want 1", client.calls)
	}

	revokeReq := feishuOrgRequest(fixture.ownerID, http.MethodDelete, fixture.workspaceID, "/api/workspaces/"+fixture.workspaceID+"/lark/installations/"+response.ID, nil, "installationId", response.ID)
	revokeWriter := httptest.NewRecorder()
	testHandler.RevokeLarkInstallation(revokeWriter, revokeReq)
	if revokeWriter.Code != http.StatusNoContent {
		t.Fatalf("revoke agent-less app status = %d, body=%s", revokeWriter.Code, revokeWriter.Body.String())
	}
}

func TestLarkWorkspaceConnectionBotAdoptionPreservesID(t *testing.T) {
	fixture := newFeishuOrgHandlerFixture(t)
	appID := "cli_adopt_" + uuid.NewString()
	created, err := testHandler.LarkInstallations.UpsertWorkspaceConnection(context.Background(), lark.WorkspaceConnectionParams{
		WorkspaceID: parseUUID(fixture.workspaceID), AppID: appID, AppSecret: "workspace-secret", InstallerUserID: parseUUID(fixture.ownerID), Region: lark.RegionFeishu,
	})
	if err != nil {
		t.Fatalf("create app connection: %v", err)
	}
	dbfx.Cleanup(t, `DELETE FROM channel_installation WHERE id = $1`, uuidToString(created.ID))
	if err := testHandler.LarkInstallations.Revoke(context.Background(), created.ID); err != nil {
		t.Fatalf("revoke app connection: %v", err)
	}
	store := lark.NewChannelStore(testHandler.Queries)
	adoptingAgentID := dbfx.Agent(t, "Feishu app adopting agent", "", testutil.Cols{"workspace_id": fixture.workspaceID, "owner_id": fixture.ownerID})
	if err := store.ReclaimDeadInstallationByAppID(context.Background(), parseUUID(fixture.workspaceID), parseUUID(adoptingAgentID), appID); err != nil {
		t.Fatalf("reclaim agent-less app: %v", err)
	}
	adopted, err := testHandler.LarkInstallations.Upsert(context.Background(), lark.InstallationParams{
		WorkspaceID: parseUUID(fixture.workspaceID), AgentID: parseUUID(adoptingAgentID), AppID: appID,
		AppSecret: "bot-secret", BotOpenID: "ou_workspace_bot", InstallerUserID: parseUUID(fixture.ownerID), Region: lark.RegionFeishu,
	})
	if err != nil {
		t.Fatalf("adopt app connection as Bot: %v", err)
	}
	if adopted.ID != created.ID || !adopted.AgentID.Valid || uuidToString(adopted.AgentID) != adoptingAgentID || adopted.Status != "active" {
		t.Fatalf("adopted app connection = %+v, original ID = %s", adopted, uuidToString(created.ID))
	}
	updated, err := testHandler.LarkInstallations.UpsertWorkspaceConnection(context.Background(), lark.WorkspaceConnectionParams{
		WorkspaceID: parseUUID(fixture.workspaceID), AppID: appID, AppSecret: "rotated-secret", InstallerUserID: parseUUID(fixture.ownerID), Region: lark.RegionFeishu,
	})
	if err != nil {
		t.Fatalf("refresh app credentials: %v", err)
	}
	if updated.ID != created.ID || !updated.AgentID.Valid || updated.BotOpenID != "ou_workspace_bot" {
		t.Fatalf("credential refresh broke the Bot route: %+v", updated)
	}
	secret, err := testHandler.LarkInstallations.DecryptAppSecret(updated)
	if err != nil || secret != "rotated-secret" {
		t.Fatalf("decrypt rotated secret: %v", err)
	}
	original, err := testHandler.LarkInstallations.GetInWorkspace(context.Background(), parseUUID(fixture.installationID), parseUUID(fixture.workspaceID))
	if err != nil || !original.AgentID.Valid || uuidToString(original.AgentID) != fixture.agentID {
		t.Fatalf("existing Bot installation changed: %+v, err=%v", original, err)
	}
}

func TestFeishuOrgSaveOwnerMappingRequiresOwner(t *testing.T) {
	fixture := newFeishuOrgHandlerFixture(t)
	mapping := LarkOrganizationMappingResponse{Kind: "department", ExternalID: "d1", MemberRole: feishuOrgRole("owner"), AgentIDs: []string{}}
	w := saveFeishuOrgConfig(t, fixture, fixture.adminID, true, []LarkOrganizationMappingResponse{mapping})
	if w.Code != http.StatusForbidden {
		t.Fatalf("admin save with owner mapping status = %d, want 403; body=%s", w.Code, w.Body.String())
	}
	if count := dbfx.Count(t, `SELECT count(*) FROM feishu_org_config WHERE workspace_id = $1`, fixture.workspaceID); count != 0 {
		t.Fatal("forbidden save persisted a config")
	}
	var role string
	if err := testPool.QueryRow(context.Background(), `SELECT role FROM member WHERE workspace_id = $1 AND user_id = $2`, fixture.workspaceID, fixture.adminID).Scan(&role); err != nil {
		t.Fatalf("load admin member: %v", err)
	}
	if role != "admin" {
		t.Fatalf("admin role changed to %q", role)
	}
}

func TestFeishuOrgAdminCannotMapAnotherOwnersAgent(t *testing.T) {
	fixture := newFeishuOrgHandlerFixture(t)
	mapping := LarkOrganizationMappingResponse{Kind: "department", ExternalID: "d1", AgentIDs: []string{fixture.agentID}}
	w := saveFeishuOrgConfig(t, fixture, fixture.adminID, true, []LarkOrganizationMappingResponse{mapping})
	if w.Code != http.StatusForbidden {
		t.Fatalf("admin save another owner's agent status = %d, want 403; body=%s", w.Code, w.Body.String())
	}
	var permissionMode string
	if err := testPool.QueryRow(context.Background(), `SELECT permission_mode FROM agent WHERE id = $1`, fixture.agentID).Scan(&permissionMode); err != nil {
		t.Fatalf("load agent: %v", err)
	}
	if permissionMode != "private" {
		t.Fatalf("forbidden save changed agent permission_mode to %q", permissionMode)
	}
}

func TestFeishuOrgSaveValidation(t *testing.T) {
	fixture := newFeishuOrgHandlerFixture(t)
	tests := []struct {
		name    string
		mapping LarkOrganizationMappingResponse
	}{
		{name: "kind", mapping: LarkOrganizationMappingResponse{Kind: "unknown", ExternalID: "d1", AgentIDs: []string{}}},
		{name: "external id", mapping: LarkOrganizationMappingResponse{Kind: "department", ExternalID: " ", AgentIDs: []string{}}},
		{name: "role", mapping: LarkOrganizationMappingResponse{Kind: "department", ExternalID: "d1", MemberRole: feishuOrgRole("superuser"), AgentIDs: []string{}}},
		{name: "foreign agent", mapping: LarkOrganizationMappingResponse{Kind: "department", ExternalID: "d1", AgentIDs: []string{uuid.NewString()}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := saveFeishuOrgConfig(t, fixture, fixture.ownerID, true, []LarkOrganizationMappingResponse{tt.mapping})
			if w.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400; body=%s", w.Code, w.Body.String())
			}
		})
	}
	duplicate := LarkOrganizationMappingResponse{Kind: "department", ExternalID: "d1", AgentIDs: []string{}}
	w := saveFeishuOrgConfig(t, fixture, fixture.ownerID, true, []LarkOrganizationMappingResponse{duplicate, duplicate})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("duplicate group status = %d, want 400; body=%s", w.Code, w.Body.String())
	}
	if count := dbfx.Count(t, `SELECT count(*) FROM feishu_org_config WHERE workspace_id = $1`, fixture.workspaceID); count != 0 {
		t.Fatal("invalid saves persisted a config")
	}
}

func TestFeishuOrgPreviewFailureIsAuditedAndReturned(t *testing.T) {
	fixture := newFeishuOrgHandlerFixture(t)
	if w := saveFeishuOrgConfig(t, fixture, fixture.ownerID, true, nil); w.Code != http.StatusOK {
		t.Fatalf("save status = %d, body=%s", w.Code, w.Body.String())
	}
	client := newFakeFeishuOrgAPIClient()
	client.err = errors.New("contact scope denied")
	wireFeishuOrgAPIClient(t, client)
	w := previewFeishuOrg(t, fixture)
	if w.Code != http.StatusOK {
		t.Fatalf("preview status = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	run := decodeFeishuOrgRun(t, w)
	if run.Status != "failed" || !strings.Contains(run.Error, "contact scope denied") || run.CompletedAt == nil {
		t.Fatalf("unexpected failed run: %+v", run)
	}
	if run.Plan.Changes == nil || run.Plan.Warnings == nil {
		t.Fatalf("failed run plan must contain empty arrays: %+v", run.Plan)
	}
	stored, err := testHandler.Queries.GetFeishuOrgSyncRunInWorkspace(context.Background(), db.GetFeishuOrgSyncRunInWorkspaceParams{ID: parseUUID(run.ID), WorkspaceID: parseUUID(fixture.workspaceID)})
	if err != nil {
		t.Fatalf("load failed run: %v", err)
	}
	if stored.Status != "failed" || !stored.Error.Valid || !strings.Contains(stored.Error.String, "contact scope denied") {
		t.Fatalf("stored failed run = %+v", stored)
	}
	if client.calls != 1 || client.credentials.AppSecret != "feishu-org-test-secret" {
		t.Fatalf("FetchOrganization calls=%d credentials=%+v", client.calls, client.credentials)
	}
}

type cancelingFeishuOrgAPIClient struct {
	*fakeFeishuOrgAPIClient
	cancel context.CancelFunc
}

func (c *cancelingFeishuOrgAPIClient) FetchOrganization(ctx context.Context, credentials lark.InstallationCredentials) (lark.OrgSnapshot, error) {
	c.cancel()
	return c.fakeFeishuOrgAPIClient.FetchOrganization(ctx, credentials)
}

func TestFeishuOrgPreviewFailureAuditSurvivesCancellation(t *testing.T) {
	fixture := newFeishuOrgHandlerFixture(t)
	if w := saveFeishuOrgConfig(t, fixture, fixture.ownerID, true, nil); w.Code != http.StatusOK {
		t.Fatalf("save status = %d, body=%s", w.Code, w.Body.String())
	}
	client := &cancelingFeishuOrgAPIClient{fakeFeishuOrgAPIClient: newFakeFeishuOrgAPIClient()}
	client.err = context.Canceled
	previous := testHandler.LarkAPIClient
	testHandler.LarkAPIClient = client
	t.Cleanup(func() { testHandler.LarkAPIClient = previous })
	req := feishuOrgRequest(fixture.ownerID, http.MethodPost, fixture.workspaceID, "/api/workspaces/"+fixture.workspaceID+"/lark/organization/preview", nil)
	ctx, cancel := context.WithCancel(req.Context())
	client.cancel = cancel
	req = req.WithContext(ctx)
	w := httptest.NewRecorder()
	testHandler.PreviewLarkOrganization(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("preview status = %d, body=%s", w.Code, w.Body.String())
	}
	run := decodeFeishuOrgRun(t, w)
	if run.Status != "failed" || !strings.Contains(run.Error, context.Canceled.Error()) || run.CompletedAt == nil {
		t.Fatalf("unexpected failed run: %+v", run)
	}
	stored, err := testHandler.Queries.GetFeishuOrgSyncRunInWorkspace(context.Background(), db.GetFeishuOrgSyncRunInWorkspaceParams{ID: parseUUID(run.ID), WorkspaceID: parseUUID(fixture.workspaceID)})
	if err != nil {
		t.Fatalf("load failed run after cancellation: %v", err)
	}
	if stored.Status != "failed" || !stored.Error.Valid || !strings.Contains(stored.Error.String, context.Canceled.Error()) {
		t.Fatalf("stored failed run after cancellation = %+v", stored)
	}
	if client.calls != 1 {
		t.Fatalf("FetchOrganization calls = %d, want 1", client.calls)
	}
}

func TestFeishuOrgApplyIsIdempotentAndReplayRecalculates(t *testing.T) {
	fixture := newFeishuOrgHandlerFixture(t)
	mapping := LarkOrganizationMappingResponse{Kind: "department", ExternalID: "d1", ExternalName: "Engineering", MemberRole: feishuOrgRole("admin"), AgentIDs: []string{}}
	if w := saveFeishuOrgConfig(t, fixture, fixture.ownerID, true, []LarkOrganizationMappingResponse{mapping}); w.Code != http.StatusOK {
		t.Fatalf("save status = %d, body=%s", w.Code, w.Body.String())
	}
	client := newFakeFeishuOrgAPIClient()
	client.snapshot = lark.OrgSnapshot{
		Complete: true, Departments: []lark.OrgDepartment{{ID: "d1", Name: "Engineering"}},
		Users: []lark.OrgUser{{OpenID: "ou_member", Email: fixture.memberEmail, Name: "Member", DepartmentIDs: []string{"d1"}, Active: true}},
	}
	wireFeishuOrgAPIClient(t, client)
	preview := previewFeishuOrg(t, fixture)
	if preview.Code != http.StatusOK {
		t.Fatalf("preview status = %d, body=%s", preview.Code, preview.Body.String())
	}
	previewRun := decodeFeishuOrgRun(t, preview)
	if previewRun.Status != "preview" || len(previewRun.Plan.Changes) != 2 || len(previewRun.Plan.RoleAssignments) != 1 {
		t.Fatalf("unexpected preview plan: %+v", previewRun.Plan)
	}

	applied := applyFeishuOrg(t, fixture, previewRun.ID)
	if applied.Code != http.StatusOK {
		t.Fatalf("apply status = %d, body=%s", applied.Code, applied.Body.String())
	}
	appliedRun := decodeFeishuOrgRun(t, applied)
	if appliedRun.Status != "completed" || appliedRun.CompletedAt == nil || appliedRun.ReplayedFromID == nil || *appliedRun.ReplayedFromID != previewRun.ID {
		t.Fatalf("unexpected apply run: %+v", appliedRun)
	}
	var role string
	var managedRole pgtype.Text
	if err := testPool.QueryRow(context.Background(), `SELECT role, feishu_managed_role FROM member WHERE workspace_id = $1 AND user_id = $2`, fixture.workspaceID, fixture.memberID).Scan(&role, &managedRole); err != nil {
		t.Fatalf("load applied member: %v", err)
	}
	if role != "admin" || !managedRole.Valid || managedRole.String != "admin" {
		t.Fatalf("applied member role=%q managed_role=%+v", role, managedRole)
	}
	if count := dbfx.Count(t, `SELECT count(*) FROM feishu_org_membership WHERE workspace_id = $1 AND user_id = $2 AND active`, fixture.workspaceID, fixture.memberID); count != 1 {
		t.Fatalf("active membership count = %d, want 1", count)
	}

	second := applyFeishuOrg(t, fixture, previewRun.ID)
	if second.Code != http.StatusOK {
		t.Fatalf("second apply status = %d, body=%s", second.Code, second.Body.String())
	}
	secondRun := decodeFeishuOrgRun(t, second)
	if secondRun.Status != "completed" || len(secondRun.Plan.Changes) != 0 {
		t.Fatalf("second apply was not idempotent: %+v", secondRun)
	}
	if count := dbfx.Count(t, `SELECT count(*) FROM feishu_org_membership WHERE workspace_id = $1 AND user_id = $2`, fixture.workspaceID, fixture.memberID); count != 1 {
		t.Fatalf("second apply duplicated membership; count=%d", count)
	}

	replayed := replayFeishuOrg(t, fixture, previewRun.ID)
	if replayed.Code != http.StatusOK {
		t.Fatalf("replay status = %d, body=%s", replayed.Code, replayed.Body.String())
	}
	replayRun := decodeFeishuOrgRun(t, replayed)
	if replayRun.Mode != "replay" || replayRun.Status != "preview" || len(replayRun.Plan.Changes) != 0 {
		t.Fatalf("replay reused the stale plan instead of current state: %+v", replayRun)
	}
	if replayRun.ReplayedFromID == nil || *replayRun.ReplayedFromID != previewRun.ID {
		t.Fatalf("replay source = %+v, want %s", replayRun.ReplayedFromID, previewRun.ID)
	}
	if client.calls != 1 {
		t.Fatalf("apply/replay contacted Feishu; FetchOrganization calls=%d", client.calls)
	}
}

func TestFeishuOrgAgentTargetChangesRequireApply(t *testing.T) {
	fixture := newFeishuOrgHandlerFixture(t)
	mapping := LarkOrganizationMappingResponse{Kind: "department", ExternalID: "d1", ExternalName: "Engineering", AgentIDs: []string{fixture.agentID}}
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
	previewRun := decodeFeishuOrgRun(t, preview)
	if len(previewRun.Plan.AgentChanges) != 1 || previewRun.Plan.AgentChanges[0].Action != "agent_granted" {
		t.Fatalf("agent preview changes = %+v", previewRun.Plan.AgentChanges)
	}
	if count := dbfx.Count(t, `SELECT count(*) FROM agent_invocation_target WHERE agent_id = $1 AND target_type = 'team'`, fixture.agentID); count != 0 {
		t.Fatal("preview created the team target")
	}
	if applied := applyFeishuOrg(t, fixture, previewRun.ID); applied.Code != http.StatusOK {
		t.Fatalf("apply status = %d, body=%s", applied.Code, applied.Body.String())
	}
	if count := dbfx.Count(t, `SELECT count(*) FROM agent_invocation_target WHERE agent_id = $1 AND target_type = 'team'`, fixture.agentID); count != 1 {
		t.Fatal("apply did not create the team target")
	}
	if count := dbfx.Count(t, `SELECT count(*) FROM feishu_org_group WHERE workspace_id = $1 AND active`, fixture.workspaceID); count != 1 {
		t.Fatal("apply did not activate the configured group")
	}

	if w := saveFeishuOrgConfig(t, fixture, fixture.ownerID, true, nil); w.Code != http.StatusOK {
		t.Fatalf("save removal status = %d, body=%s", w.Code, w.Body.String())
	}
	if count := dbfx.Count(t, `SELECT count(*) FROM agent_invocation_target WHERE agent_id = $1 AND target_type = 'team'`, fixture.agentID); count != 1 {
		t.Fatal("saving desired removal revoked access before a new apply")
	}
	if count := dbfx.Count(t, `SELECT count(*) FROM feishu_org_group WHERE workspace_id = $1 AND active`, fixture.workspaceID); count != 1 {
		t.Fatal("saving desired removal deactivated the group before a new apply")
	}
	secondPreview := previewFeishuOrg(t, fixture)
	secondRun := decodeFeishuOrgRun(t, secondPreview)
	if len(secondRun.Plan.AgentChanges) != 1 || secondRun.Plan.AgentChanges[0].Action != "agent_revoked" {
		t.Fatalf("agent removal preview changes = %+v", secondRun.Plan.AgentChanges)
	}
	if applied := applyFeishuOrg(t, fixture, secondRun.ID); applied.Code != http.StatusOK {
		t.Fatalf("removal apply status = %d, body=%s", applied.Code, applied.Body.String())
	}
	if count := dbfx.Count(t, `SELECT count(*) FROM agent_invocation_target WHERE agent_id = $1 AND target_type = 'team'`, fixture.agentID); count != 0 {
		t.Fatal("removal apply left the team target")
	}
	if count := dbfx.Count(t, `SELECT count(*) FROM feishu_org_group WHERE workspace_id = $1 AND active`, fixture.workspaceID); count != 0 {
		t.Fatal("removal apply left the group active")
	}
}

func TestFeishuOrgExistingTargetStillRequiresOwnerForActivation(t *testing.T) {
	fixture := newFeishuOrgHandlerFixture(t)
	mapping := LarkOrganizationMappingResponse{Kind: "department", ExternalID: "d1", ExternalName: "Engineering", AgentIDs: []string{fixture.agentID}}
	if w := saveFeishuOrgConfig(t, fixture, fixture.ownerID, true, []LarkOrganizationMappingResponse{mapping}); w.Code != http.StatusOK {
		t.Fatalf("save status = %d, body=%s", w.Code, w.Body.String())
	}
	var groupID string
	if err := testPool.QueryRow(context.Background(), `SELECT id FROM feishu_org_group WHERE workspace_id = $1`, fixture.workspaceID).Scan(&groupID); err != nil {
		t.Fatalf("load group: %v", err)
	}
	dbfx.Exec(t, `INSERT INTO agent_invocation_target (agent_id, target_type, target_id, created_by) VALUES ($1, 'team', $2, $3)`, fixture.agentID, groupID, fixture.ownerID)
	client := newFakeFeishuOrgAPIClient()
	client.snapshot = lark.OrgSnapshot{Complete: true, Departments: []lark.OrgDepartment{{ID: "d1"}}}
	wireFeishuOrgAPIClient(t, client)
	preview := previewFeishuOrg(t, fixture)
	previewRun := decodeFeishuOrgRun(t, preview)
	if len(previewRun.Plan.AgentChanges) != 1 || previewRun.Plan.AgentChanges[0].Action != "agent_granted" {
		t.Fatalf("inactive/private target produced no effective-access change: %+v", previewRun.Plan.AgentChanges)
	}
	req := feishuOrgRequest(fixture.adminID, http.MethodPost, fixture.workspaceID, "/api/workspaces/"+fixture.workspaceID+"/lark/organization/sync/"+previewRun.ID+"/apply", nil, "runId", previewRun.ID)
	w := httptest.NewRecorder()
	testHandler.ApplyLarkOrganizationSync(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("admin activated another owner's agent: status=%d body=%s", w.Code, w.Body.String())
	}
	if count := dbfx.Count(t, `SELECT count(*) FROM feishu_org_group WHERE id = $1 AND active`, groupID); count != 0 {
		t.Fatal("forbidden apply activated the group")
	}
	if applied := applyFeishuOrg(t, fixture, previewRun.ID); applied.Code != http.StatusOK {
		t.Fatalf("owner apply status = %d, body=%s", applied.Code, applied.Body.String())
	}
	var permissionMode string
	if err := testPool.QueryRow(context.Background(), `SELECT permission_mode FROM agent WHERE id = $1`, fixture.agentID).Scan(&permissionMode); err != nil {
		t.Fatalf("load agent: %v", err)
	}
	if permissionMode != "public_to" {
		t.Fatalf("owner apply left permission_mode = %q", permissionMode)
	}
}

func TestFeishuOrgAdminCannotApplyOwnerAccessChange(t *testing.T) {
	fixture := newFeishuOrgHandlerFixture(t)
	mapping := LarkOrganizationMappingResponse{Kind: "department", ExternalID: "d1", MemberRole: feishuOrgRole("owner"), AgentIDs: []string{}}
	if w := saveFeishuOrgConfig(t, fixture, fixture.ownerID, true, []LarkOrganizationMappingResponse{mapping}); w.Code != http.StatusOK {
		t.Fatalf("save status = %d, body=%s", w.Code, w.Body.String())
	}
	client := newFakeFeishuOrgAPIClient()
	client.snapshot = lark.OrgSnapshot{
		Complete: true, Departments: []lark.OrgDepartment{{ID: "d1"}},
		Users: []lark.OrgUser{{OpenID: "ou_member", Email: fixture.memberEmail, DepartmentIDs: []string{"d1"}, Active: true}},
	}
	wireFeishuOrgAPIClient(t, client)
	preview := previewFeishuOrg(t, fixture)
	previewRun := decodeFeishuOrgRun(t, preview)
	req := feishuOrgRequest(fixture.adminID, http.MethodPost, fixture.workspaceID, "/api/workspaces/"+fixture.workspaceID+"/lark/organization/sync/"+previewRun.ID+"/apply", nil, "runId", previewRun.ID)
	w := httptest.NewRecorder()
	testHandler.ApplyLarkOrganizationSync(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("admin apply owner change status = %d, want 403; body=%s", w.Code, w.Body.String())
	}
	var role string
	if err := testPool.QueryRow(context.Background(), `SELECT role FROM member WHERE workspace_id = $1 AND user_id = $2`, fixture.workspaceID, fixture.memberID).Scan(&role); err != nil {
		t.Fatalf("load member: %v", err)
	}
	if role != "member" {
		t.Fatalf("admin apply changed member role to %q", role)
	}
}

func TestFeishuOrgDisabledSyncRejectsReplayAndApply(t *testing.T) {
	fixture := newFeishuOrgHandlerFixture(t)
	if w := saveFeishuOrgConfig(t, fixture, fixture.ownerID, true, nil); w.Code != http.StatusOK {
		t.Fatalf("save status = %d, body=%s", w.Code, w.Body.String())
	}
	client := newFakeFeishuOrgAPIClient()
	client.snapshot = lark.OrgSnapshot{Complete: true}
	wireFeishuOrgAPIClient(t, client)
	preview := previewFeishuOrg(t, fixture)
	previewRun := decodeFeishuOrgRun(t, preview)
	if w := saveFeishuOrgConfig(t, fixture, fixture.ownerID, false, nil); w.Code != http.StatusOK {
		t.Fatalf("disable save status = %d, body=%s", w.Code, w.Body.String())
	}
	if replayed := replayFeishuOrg(t, fixture, previewRun.ID); replayed.Code != http.StatusConflict {
		t.Fatalf("disabled replay status = %d, want 409", replayed.Code)
	}
	if applied := applyFeishuOrg(t, fixture, previewRun.ID); applied.Code != http.StatusConflict {
		t.Fatalf("disabled apply status = %d, want 409", applied.Code)
	}
}

func TestFeishuOrgRejectsCrossWorkspaceRun(t *testing.T) {
	sourceFixture := newFeishuOrgHandlerFixture(t)
	otherFixture := newFeishuOrgHandlerFixture(t)
	snapshot := []byte(`{"Complete":true,"Departments":[],"Users":[]}`)
	actor := feishuOrgActor{workspaceID: parseUUID(sourceFixture.workspaceID), userID: parseUUID(sourceFixture.ownerID)}
	source, err := testHandler.createFeishuOrgSyncRun(context.Background(), testHandler.Queries, actor, "preview", "preview", 1, snapshot, emptyFeishuOrgPlan(), "", pgtype.UUID{})
	if err != nil {
		t.Fatalf("create source run: %v", err)
	}
	for _, operation := range []struct {
		name string
		call func(*testing.T, feishuOrgHandlerFixture, string) *httptest.ResponseRecorder
	}{
		{name: "apply", call: applyFeishuOrg},
		{name: "replay", call: replayFeishuOrg},
	} {
		t.Run(operation.name, func(t *testing.T) {
			w := operation.call(t, otherFixture, uuidToString(source.ID))
			if w.Code != http.StatusNotFound {
				t.Fatalf("cross-workspace %s status = %d, want 404; body=%s", operation.name, w.Code, w.Body.String())
			}
		})
	}
}
