package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/integrations/lark"
)

func setFeishuLoginApp(t *testing.T, appID string) {
	t.Helper()
	t.Setenv("FEISHU_APP_ID", appID)
	t.Setenv("FEISHU_APP_SECRET", "login-app-secret")
	dbfx.Cleanup(t, `DELETE FROM feishu_org_directory WHERE installation_id = $1`, uuidToString(feishuOrgLoginAppDirectoryKey(appID)))
}

func saveFeishuOrgSource(t *testing.T, fixture feishuOrgHandlerFixture, request UpdateLarkOrganizationRequest) *httptest.ResponseRecorder {
	t.Helper()
	req := feishuOrgRequest(fixture.ownerID, http.MethodPut, fixture.workspaceID, "/api/workspaces/"+fixture.workspaceID+"/lark/organization", request)
	w := httptest.NewRecorder()
	testHandler.UpdateLarkOrganization(w, req)
	return w
}

func getFeishuOrg(t *testing.T, fixture feishuOrgHandlerFixture) LarkOrganizationResponse {
	t.Helper()
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
	return response
}

// The login app source reads with the environment's credentials and never
// touches channel_installation: the installation service is unset for the
// whole flow.
func TestFeishuOrgLoginAppSourcePreviewApplyAndAutoSync(t *testing.T) {
	fixture := newFeishuOrgHandlerFixture(t)
	appID := "cli_login_app_" + uuid.NewString()
	setFeishuLoginApp(t, appID)
	previousInstallations := testHandler.LarkInstallations
	testHandler.LarkInstallations = nil
	t.Cleanup(func() { testHandler.LarkInstallations = previousInstallations })

	w := saveFeishuOrgSource(t, fixture, UpdateLarkOrganizationRequest{
		Source: feishuOrgSourceLoginApp, Enabled: true, AutoSync: true,
		Mappings: []LarkOrganizationMappingResponse{{Kind: "department", ExternalID: "d1", ExternalName: "Engineering", MemberRole: feishuOrgRole("admin")}},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("save status = %d, body=%s", w.Code, w.Body.String())
	}
	var saved LarkOrganizationResponse
	if err := json.Unmarshal(w.Body.Bytes(), &saved); err != nil {
		t.Fatalf("decode saved: %v", err)
	}
	if saved.Config == nil || saved.Config.Source != feishuOrgSourceLoginApp || saved.Config.InstallationID != "" {
		t.Fatalf("saved config = %+v, want login_app source without installation", saved.Config)
	}
	if saved.LoginApp == nil || saved.LoginApp.AppID != appID {
		t.Fatalf("login_app = %+v, want %s", saved.LoginApp, appID)
	}

	client := newFakeFeishuOrgAPIClient()
	client.snapshot = lark.OrgSnapshot{
		Complete:    true,
		Departments: []lark.OrgDepartment{{ID: "d1", Name: "Engineering", ParentID: "0"}},
		Users:       []lark.OrgUser{{OpenID: "ou_member", Email: fixture.memberEmail, Name: "Member", DepartmentIDs: []string{"d1"}, Active: true}},
	}
	wireFeishuOrgAPIClient(t, client)

	preview := previewFeishuOrg(t, fixture)
	if preview.Code != http.StatusOK {
		t.Fatalf("preview status = %d, body=%s", preview.Code, preview.Body.String())
	}
	run := decodeFeishuOrgRun(t, preview)
	if run.Status != "preview" {
		t.Fatalf("preview run = %+v, want a preview", run)
	}
	if client.credentials.AppID != appID || client.credentials.AppSecret != "login-app-secret" {
		t.Fatalf("fetched with app %q, want the login app's environment credentials", client.credentials.AppID)
	}
	directoryKey := uuidToString(feishuOrgLoginAppDirectoryKey(appID))
	if count := dbfx.Count(t, `SELECT count(*) FROM feishu_org_directory WHERE installation_id = $1`, directoryKey); count != 1 {
		t.Fatalf("login app directory rows = %d, want 1", count)
	}
	if count := dbfx.Count(t, `SELECT count(*) FROM channel_installation WHERE config ->> 'app_id' = $1`, appID); count != 0 {
		t.Fatalf("channel_installation rows for the login app = %d, want none", count)
	}
	if applied := applyFeishuOrg(t, fixture, run.ID); applied.Code != http.StatusOK {
		t.Fatalf("apply status = %d, body=%s", applied.Code, applied.Body.String())
	}
	var memberRole string
	if err := testPool.QueryRow(context.Background(), `SELECT role FROM member WHERE workspace_id = $1 AND user_id = $2`, fixture.workspaceID, fixture.memberID).Scan(&memberRole); err != nil {
		t.Fatalf("load member: %v", err)
	}
	if memberRole != "admin" {
		t.Fatalf("member role after apply = %q, want admin", memberRole)
	}

	calls := client.calls
	if _, err := testHandler.SyncFeishuOrganizations(context.Background()); err != nil {
		t.Logf("SyncFeishuOrganizations reported another workspace's error: %v", err)
	}
	if client.calls != calls+1 || client.credentials.AppID != appID {
		t.Fatalf("auto sync calls = %d (was %d) app = %q, want one fetch with the login app", client.calls, calls, client.credentials.AppID)
	}
	if count := dbfx.Count(t, `SELECT count(*) FROM feishu_org_sync_run WHERE workspace_id = $1 AND mode = 'auto' AND status = 'completed'`, fixture.workspaceID); count != 1 {
		t.Fatalf("completed auto runs = %d, want 1", count)
	}
	if got := getFeishuOrg(t, fixture); got.Catalog == nil {
		t.Fatal("catalog from the login app directory is missing")
	}
}

func TestFeishuOrgLoginAppSourceRequiresConfiguredLoginApp(t *testing.T) {
	fixture := newFeishuOrgHandlerFixture(t)
	t.Setenv("FEISHU_APP_ID", "")
	t.Setenv("FEISHU_APP_SECRET", "")
	w := saveFeishuOrgSource(t, fixture, UpdateLarkOrganizationRequest{Source: feishuOrgSourceLoginApp, Enabled: true})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("save status = %d, want 400; body=%s", w.Code, w.Body.String())
	}
	if got := getFeishuOrg(t, fixture); got.LoginApp != nil {
		t.Fatalf("login_app = %+v, want absent when not configured", got.LoginApp)
	}
}

// Old clients send no source; the installation source keeps working.
func TestFeishuOrgSourceDefaultsToInstallation(t *testing.T) {
	fixture := newFeishuOrgHandlerFixture(t)
	if w := saveFeishuOrgConfig(t, fixture, fixture.ownerID, true, nil); w.Code != http.StatusOK {
		t.Fatalf("save status = %d, body=%s", w.Code, w.Body.String())
	}
	got := getFeishuOrg(t, fixture)
	if got.Config == nil || got.Config.Source != feishuOrgSourceInstallation || got.Config.InstallationID != fixture.installationID {
		t.Fatalf("config = %+v, want the installation source", got.Config)
	}
}

func TestSwitchFeishuOrgSourcesToLoginApp(t *testing.T) {
	t.Run("revoked installation", func(t *testing.T) {
		fixture := newFeishuOrgHandlerFixture(t)
		setFeishuLoginApp(t, "cli_login_app_"+uuid.NewString())
		if w := saveFeishuOrgConfig(t, fixture, fixture.ownerID, true, nil); w.Code != http.StatusOK {
			t.Fatalf("save status = %d, body=%s", w.Code, w.Body.String())
		}
		if _, err := testPool.Exec(context.Background(), `UPDATE channel_installation SET status = 'revoked' WHERE id = $1`, fixture.installationID); err != nil {
			t.Fatalf("revoke: %v", err)
		}
		assertFeishuOrgSwitchedToLoginApp(t, fixture)
	})
	t.Run("installation of the login app", func(t *testing.T) {
		fixture := newFeishuOrgHandlerFixture(t)
		var appID string
		if err := testPool.QueryRow(context.Background(), `SELECT config ->> 'app_id' FROM channel_installation WHERE id = $1`, fixture.installationID).Scan(&appID); err != nil {
			t.Fatalf("load app id: %v", err)
		}
		setFeishuLoginApp(t, appID)
		if w := saveFeishuOrgConfig(t, fixture, fixture.ownerID, true, nil); w.Code != http.StatusOK {
			t.Fatalf("save status = %d, body=%s", w.Code, w.Body.String())
		}
		assertFeishuOrgSwitchedToLoginApp(t, fixture)
	})
	t.Run("active installation of another app stays", func(t *testing.T) {
		fixture := newFeishuOrgHandlerFixture(t)
		setFeishuLoginApp(t, "cli_login_app_"+uuid.NewString())
		if w := saveFeishuOrgConfig(t, fixture, fixture.ownerID, true, nil); w.Code != http.StatusOK {
			t.Fatalf("save status = %d, body=%s", w.Code, w.Body.String())
		}
		if err := testHandler.SwitchFeishuOrgSourcesToLoginApp(context.Background()); err != nil {
			t.Fatalf("switch: %v", err)
		}
		if got := getFeishuOrg(t, fixture); got.Config == nil || got.Config.Source != feishuOrgSourceInstallation {
			t.Fatalf("config = %+v, want the installation source kept", got.Config)
		}
	})
}

func assertFeishuOrgSwitchedToLoginApp(t *testing.T, fixture feishuOrgHandlerFixture) {
	t.Helper()
	before := getFeishuOrg(t, fixture)
	if err := testHandler.SwitchFeishuOrgSourcesToLoginApp(context.Background()); err != nil {
		t.Fatalf("switch: %v", err)
	}
	after := getFeishuOrg(t, fixture)
	if after.Config == nil || after.Config.Source != feishuOrgSourceLoginApp || after.Config.InstallationID != "" {
		t.Fatalf("config = %+v, want the login app source", after.Config)
	}
	if after.Config.Revision != before.Config.Revision+1 {
		t.Fatalf("revision = %d, want %d so earlier previews no longer apply", after.Config.Revision, before.Config.Revision+1)
	}
}

// A contact event that arrives on the login app's own installation refreshes
// workspaces reading from the login app.
func TestFeishuOrgContactEventOnLoginAppRefreshesLoginAppSource(t *testing.T) {
	fixture := newFeishuOrgHandlerFixture(t)
	appID := "cli_login_app_" + uuid.NewString()
	setFeishuLoginApp(t, appID)
	if w := saveFeishuOrgSource(t, fixture, UpdateLarkOrganizationRequest{Source: feishuOrgSourceLoginApp, Enabled: true}); w.Code != http.StatusOK {
		t.Fatalf("save status = %d, body=%s", w.Code, w.Body.String())
	}
	client := newFakeFeishuOrgAPIClient()
	client.snapshot = lark.OrgSnapshot{Complete: true}
	wireFeishuOrgAPIClient(t, client)

	if err := testHandler.SyncFeishuOrganizationInstallation(context.Background(), lark.Installation{ID: parseUUID(uuid.NewString()), AppID: "cli_other_app"}); err != nil {
		t.Fatalf("unrelated event: %v", err)
	}
	if client.calls != 0 {
		t.Fatalf("an event from another app fetched %d times, want 0", client.calls)
	}
	if err := testHandler.SyncFeishuOrganizationInstallation(context.Background(), lark.Installation{ID: parseUUID(uuid.NewString()), AppID: appID}); err != nil {
		t.Fatalf("login app event: %v", err)
	}
	if client.calls != 1 || client.credentials.AppID != appID {
		t.Fatalf("calls = %d app = %q, want one fetch with the login app", client.calls, client.credentials.AppID)
	}
}
