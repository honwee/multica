package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/integrations/lark"
)

func cleanupInheritedFeishuOrg(t *testing.T, workspaceID string) {
	t.Helper()
	t.Cleanup(func() {
		_, _ = testPool.Exec(context.Background(), `DELETE FROM feishu_org_sync_run WHERE workspace_id = $1`, workspaceID)
		_, _ = testPool.Exec(context.Background(), `DELETE FROM feishu_org_membership WHERE workspace_id = $1`, workspaceID)
		_, _ = testPool.Exec(context.Background(), `DELETE FROM feishu_org_role_mapping WHERE workspace_id = $1`, workspaceID)
		_, _ = testPool.Exec(context.Background(), `DELETE FROM feishu_org_group WHERE workspace_id = $1`, workspaceID)
		_, _ = testPool.Exec(context.Background(), `DELETE FROM feishu_org_config WHERE workspace_id = $1`, workspaceID)
	})
}

func TestCreateWorkspaceInheritsFeishuOrgFromAdminWorkspace(t *testing.T) {
	fixture := newFeishuOrgHandlerFixture(t)
	if w := saveFeishuOrgConfig(t, fixture, fixture.ownerID, true, []LarkOrganizationMappingResponse{{
		Kind: "department", ExternalID: "d1", ExternalName: "Engineering",
		MemberRole: feishuOrgRole("member"),
	}}); w.Code != http.StatusOK {
		t.Fatalf("save source config: status=%d body=%s", w.Code, w.Body.String())
	}
	client := newFakeFeishuOrgAPIClient()
	client.snapshot = lark.OrgSnapshot{
		Complete:    true,
		Departments: []lark.OrgDepartment{{ID: "d1", Name: "Engineering"}},
		Users:       []lark.OrgUser{{OpenID: "ou_one", Name: "Member", Active: true, DepartmentIDs: []string{"d1"}}},
	}
	wireFeishuOrgAPIClient(t, client)
	if w := previewFeishuOrg(t, fixture); w.Code != http.StatusOK {
		t.Fatalf("preview source: status=%d body=%s", w.Code, w.Body.String())
	}

	slug := "inherited-org-" + uuid.NewString()
	req := newRequestAs(fixture.ownerID, http.MethodPost, "/api/workspaces", CreateWorkspaceRequest{Name: "Inherited Org", Slug: slug})
	w := httptest.NewRecorder()
	testHandler.CreateWorkspace(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("create inherited workspace: status=%d body=%s", w.Code, w.Body.String())
	}
	var created WorkspaceResponse
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode created workspace: %v", err)
	}
	cleanupInheritedFeishuOrg(t, created.ID)
	workspaceID := parseUUID(created.ID)

	config, err := testHandler.Queries.GetFeishuOrgConfig(context.Background(), workspaceID)
	if err != nil {
		t.Fatalf("load inherited config: %v", err)
	}
	if !config.Enabled || uuidToString(config.InstallationID) != fixture.installationID {
		t.Fatalf("unexpected inherited config: %+v", config)
	}
	groups, err := testHandler.Queries.ListFeishuOrgGroups(context.Background(), workspaceID)
	if err != nil || len(groups) != 1 || groups[0].ExternalID != "d1" {
		t.Fatalf("unexpected inherited groups: %+v err=%v", groups, err)
	}
	roles, err := testHandler.Queries.ListFeishuOrgRoleMappings(context.Background(), workspaceID)
	if err != nil || len(roles) != 1 || roles[0].Role != "member" {
		t.Fatalf("unexpected inherited role mappings: %+v err=%v", roles, err)
	}
	// Run history stays with the source; the directory is shared through
	// the installation, so the catalog below still renders.
	runs, err := testHandler.Queries.ListFeishuOrgSyncRuns(context.Background(), workspaceID)
	if err != nil || len(runs) != 0 {
		t.Fatalf("unexpected inherited sync runs: %+v err=%v", runs, err)
	}

	req = feishuOrgRequest(fixture.ownerID, http.MethodGet, created.ID, "/api/workspaces/"+created.ID+"/lark/organization", nil)
	w = httptest.NewRecorder()
	testHandler.GetLarkOrganization(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("get inherited organization: status=%d body=%s", w.Code, w.Body.String())
	}
	var response LarkOrganizationResponse
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode inherited organization: %v", err)
	}
	if response.Catalog == nil || response.Catalog.TotalUsers != 1 || len(response.Mappings) != 1 {
		t.Fatalf("inherited organization is incomplete: %+v", response)
	}

	targetFixture := fixture
	targetFixture.workspaceID = created.ID
	if preview := previewFeishuOrg(t, targetFixture); preview.Code != http.StatusOK {
		t.Fatalf("preview with shared installation: status=%d body=%s", preview.Code, preview.Body.String())
	}
	if saved := saveFeishuOrgConfig(t, targetFixture, fixture.ownerID, true, nil); saved.Code != http.StatusOK {
		t.Fatalf("save with shared installation: status=%d body=%s", saved.Code, saved.Body.String())
	}
	// Turning sync off in the inherited workspace must not lock it out of the
	// shared installation: the next save has to be able to turn it back on.
	if saved := saveFeishuOrgConfig(t, targetFixture, fixture.ownerID, false, nil); saved.Code != http.StatusOK {
		t.Fatalf("disable with shared installation: status=%d body=%s", saved.Code, saved.Body.String())
	}
	if saved := saveFeishuOrgConfig(t, targetFixture, fixture.ownerID, true, nil); saved.Code != http.StatusOK {
		t.Fatalf("re-enable with shared installation: status=%d body=%s", saved.Code, saved.Body.String())
	}
	if err := testHandler.Queries.DeleteFeishuOrgDataByWorkspace(context.Background(), parseUUID(fixture.workspaceID)); err != nil {
		t.Fatalf("remove source organization config: %v", err)
	}
	if preview := previewFeishuOrg(t, targetFixture); preview.Code != http.StatusNotFound {
		t.Fatalf("shared access must fail after source removal: status=%d body=%s", preview.Code, preview.Body.String())
	}
}

func TestCreateWorkspaceDoesNotInheritAdminFeishuOrgFromPlainMember(t *testing.T) {
	fixture := newFeishuOrgHandlerFixture(t)
	if w := saveFeishuOrgConfig(t, fixture, fixture.ownerID, true, nil); w.Code != http.StatusOK {
		t.Fatalf("save source config: status=%d body=%s", w.Code, w.Body.String())
	}

	slug := "member-owned-org-" + uuid.NewString()
	req := newRequestAs(fixture.memberID, http.MethodPost, "/api/workspaces", CreateWorkspaceRequest{Name: "Member Owned Org", Slug: slug})
	w := httptest.NewRecorder()
	testHandler.CreateWorkspace(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("create member workspace: status=%d body=%s", w.Code, w.Body.String())
	}
	var created WorkspaceResponse
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode member workspace: %v", err)
	}
	cleanupInheritedFeishuOrg(t, created.ID)
	_, err := testHandler.Queries.GetFeishuOrgConfig(context.Background(), parseUUID(created.ID))
	if !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("plain member must not inherit admin organization config: err=%v", err)
	}
}
