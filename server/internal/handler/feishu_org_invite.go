package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/integrations/lark"
)

var (
	errFeishuInviteeNotFound = errors.New("feishu member not found")
	errFeishuInviteeInactive = errors.New("feishu member is inactive")
	errFeishuInviteeIdentity = errors.New("feishu member has no invitable identity")
)

// workspaceFeishuOrgDirectory loads the directory of the installation the
// workspace's organization config points at.
func (h *Handler) workspaceFeishuOrgDirectory(ctx context.Context, workspaceID pgtype.UUID) (lark.OrgSnapshot, error) {
	directory, err := h.Queries.GetFeishuOrgDirectoryForWorkspace(ctx, workspaceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return lark.OrgSnapshot{}, errFeishuOrgDirectoryMissing
	}
	if err != nil {
		return lark.OrgSnapshot{}, err
	}
	var snapshot lark.OrgSnapshot
	if err := json.Unmarshal(directory.Snapshot, &snapshot); err != nil {
		return lark.OrgSnapshot{}, err
	}
	if !snapshot.Complete {
		return lark.OrgSnapshot{}, errFeishuOrgDirectoryMissing
	}
	return snapshot, nil
}

// resolveFeishuInvitationEmail resolves an invitation from the same directory
// that powers the admin's organization catalog. The client only sends a union
// ID; OpenIDs and email aliases stay on the server.
func (h *Handler) resolveFeishuInvitationEmail(ctx context.Context, workspaceID pgtype.UUID, unionID string) (string, error) {
	unionID = strings.TrimSpace(unionID)
	if unionID == "" {
		return "", errFeishuInviteeNotFound
	}
	snapshot, err := h.workspaceFeishuOrgDirectory(ctx, workspaceID)
	if errors.Is(err, errFeishuOrgDirectoryMissing) {
		return "", errFeishuInviteeNotFound
	}
	if err != nil {
		return "", err
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

// addFeishuInvitationNames resolves internal OpenID aliases back to display
// names from the directory. Failure to refresh this optional label never
// blocks creating or listing an invitation.
func (h *Handler) addFeishuInvitationNames(ctx context.Context, workspaceID pgtype.UUID, invitations []InvitationResponse) {
	snapshot, err := h.workspaceFeishuOrgDirectory(ctx, workspaceID)
	if err != nil {
		return
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
