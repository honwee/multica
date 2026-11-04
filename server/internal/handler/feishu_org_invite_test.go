package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/multica-ai/multica/server/internal/integrations/lark"
)

func previewFeishuInviteSnapshot(t *testing.T, fixture feishuOrgHandlerFixture) {
	t.Helper()
	client := newFakeFeishuOrgAPIClient()
	client.snapshot = lark.OrgSnapshot{
		Complete: true,
		Users: []lark.OrgUser{
			{OpenID: "ou_email", UnionID: "on_email", Email: "person@example.com", Name: "Email User", Active: true},
			{OpenID: "ou_openid", UnionID: "on_openid", Name: "OpenID User", Active: true},
		},
	}
	wireFeishuOrgAPIClient(t, client)
	if response := saveFeishuOrgConfig(t, fixture, fixture.ownerID, true, nil); response.Code != http.StatusOK {
		t.Fatalf("save config status = %d, body=%s", response.Code, response.Body.String())
	}
	if response := previewFeishuOrg(t, fixture); response.Code != http.StatusOK {
		t.Fatalf("preview status = %d, body=%s", response.Code, response.Body.String())
	}
}

func TestFeishuInvitationByUnionID(t *testing.T) {
	for _, test := range []struct {
		name      string
		unionID   string
		wantEmail string
		wantName  string
	}{
		{name: "uses the available email", unionID: "on_email", wantEmail: "person@example.com", wantName: "Email User"},
		{name: "uses the OpenID fallback alias", unionID: "on_openid", wantEmail: "ou_openid@feishu.invalid", wantName: "OpenID User"},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newFeishuOrgHandlerFixture(t)
			previewFeishuInviteSnapshot(t, fixture)
			req := feishuOrgRequest(fixture.ownerID, http.MethodPost, fixture.workspaceID, "/api/workspaces/"+fixture.workspaceID+"/members", CreateMemberRequest{
				FeishuUnionID: test.unionID, Role: "member",
			})
			w := httptest.NewRecorder()
			testHandler.CreateInvitation(w, req)
			if w.Code != http.StatusCreated {
				t.Fatalf("invite status = %d, body=%s", w.Code, w.Body.String())
			}
			var response InvitationResponse
			if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
				t.Fatalf("decode invitation: %v", err)
			}
			if response.InviteeEmail != test.wantEmail {
				t.Fatalf("invitee email = %q, want %q", response.InviteeEmail, test.wantEmail)
			}
			if response.InviteeName != test.wantName {
				t.Fatalf("invitee name = %q, want %q", response.InviteeName, test.wantName)
			}
			listReq := feishuOrgRequest(fixture.ownerID, http.MethodGet, fixture.workspaceID, "/api/workspaces/"+fixture.workspaceID+"/invitations", nil)
			listResponse := httptest.NewRecorder()
			testHandler.ListWorkspaceInvitations(listResponse, listReq)
			if listResponse.Code != http.StatusOK {
				t.Fatalf("list invitations status = %d, body=%s", listResponse.Code, listResponse.Body.String())
			}
			var invitations []InvitationResponse
			if err := json.Unmarshal(listResponse.Body.Bytes(), &invitations); err != nil {
				t.Fatalf("decode invitations: %v", err)
			}
			if len(invitations) != 1 || invitations[0].InviteeName != test.wantName {
				t.Fatalf("listed invitations = %+v, want name %q", invitations, test.wantName)
			}
		})
	}
}

func TestFeishuInvitationRejectsUnknownUnionID(t *testing.T) {
	fixture := newFeishuOrgHandlerFixture(t)
	previewFeishuInviteSnapshot(t, fixture)
	req := feishuOrgRequest(fixture.ownerID, http.MethodPost, fixture.workspaceID, "/api/workspaces/"+fixture.workspaceID+"/members", CreateMemberRequest{
		FeishuUnionID: "on_missing", Role: "member",
	})
	w := httptest.NewRecorder()
	testHandler.CreateInvitation(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("invite status = %d, want 404; body=%s", w.Code, w.Body.String())
	}
}
