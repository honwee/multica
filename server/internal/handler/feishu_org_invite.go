package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/integrations/lark"
)

var (
	errFeishuInviteeNotFound = errors.New("feishu member not found")
	errFeishuInviteeInactive = errors.New("feishu member is inactive")
	errFeishuInviteeIdentity = errors.New("feishu member has no invitable identity")
)

// resolveFeishuInvitationEmail resolves an invitation from the same complete
// snapshot that powers the admin's organization catalog. The client only sends
// a union ID; OpenIDs and email aliases stay on the server.
func (h *Handler) resolveFeishuInvitationEmail(ctx context.Context, workspaceID pgtype.UUID, unionID string) (string, error) {
	unionID = strings.TrimSpace(unionID)
	if unionID == "" {
		return "", errFeishuInviteeNotFound
	}
	runs, err := h.Queries.ListFeishuOrgSyncRuns(ctx, workspaceID)
	if err != nil {
		return "", err
	}
	for _, run := range runs {
		if run.Mode != "preview" || run.Status != "preview" {
			continue
		}
		var snapshot lark.OrgSnapshot
		if err := json.Unmarshal(run.Snapshot, &snapshot); err != nil {
			return "", err
		}
		if !snapshot.Complete {
			continue
		}
		for _, user := range snapshot.Users {
			if user.UnionID != unionID {
				continue
			}
			if !user.Active {
				return "", errFeishuInviteeInactive
			}
			// Same precedence as FeishuLogin, so the invitation lands on the
			// account the invitee gets when they sign in.
			if email := user.LoginEmail(); email != "" {
				return email, nil
			}
			if openID := strings.ToLower(strings.TrimSpace(user.OpenID)); openID != "" {
				return openID + "@feishu.invalid", nil
			}
			return "", errFeishuInviteeIdentity
		}
		return "", errFeishuInviteeNotFound
	}
	return "", errFeishuInviteeNotFound
}

// addFeishuInvitationNames resolves internal OpenID aliases back to display
// names from the same snapshot. Failure to refresh this optional label never
// blocks creating or listing an invitation.
func (h *Handler) addFeishuInvitationNames(ctx context.Context, workspaceID pgtype.UUID, invitations []InvitationResponse) {
	runs, err := h.Queries.ListFeishuOrgSyncRuns(ctx, workspaceID)
	if err != nil {
		return
	}
	for _, run := range runs {
		if run.Mode != "preview" || run.Status != "preview" {
			continue
		}
		var snapshot lark.OrgSnapshot
		if err := json.Unmarshal(run.Snapshot, &snapshot); err != nil || !snapshot.Complete {
			continue
		}
		names := make(map[string]string, len(snapshot.Users))
		for _, user := range snapshot.Users {
			if user.Name == "" {
				continue
			}
			if openID := strings.ToLower(strings.TrimSpace(user.OpenID)); openID != "" {
				names[openID+"@feishu.invalid"] = user.Name
			}
			for _, email := range []string{user.EnterpriseEmail, user.Email} {
				if email = strings.ToLower(strings.TrimSpace(email)); email != "" {
					names[email] = user.Name
				}
			}
		}
		for i := range invitations {
			invitations[i].InviteeName = names[strings.ToLower(invitations[i].InviteeEmail)]
		}
		return
	}
}

func writeFeishuInvitationResolveError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errFeishuInviteeNotFound):
		writeError(w, http.StatusNotFound, "feishu member not found")
	case errors.Is(err, errFeishuInviteeInactive):
		writeError(w, http.StatusConflict, "feishu member is inactive")
	case errors.Is(err, errFeishuInviteeIdentity):
		writeError(w, http.StatusBadRequest, "feishu member has no invitable identity")
	default:
		writeError(w, http.StatusInternalServerError, "failed to resolve Feishu member")
	}
}
