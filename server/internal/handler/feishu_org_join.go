package handler

import (
	"context"
	"errors"
	"log/slog"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/feishuorg"
	"github.com/multica-ai/multica/server/internal/integrations/lark"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// joinFeishuOrganizationWorkspaces adds a freshly signed-in Feishu user to
// every workspace whose automatic organization sync has a rule covering
// them, so the organization decides membership instead of a manual invite.
// It never blocks the login: failures are logged and the hourly sync
// reconciles later. Owner is never granted unattended; an owner rule joins
// the user as admin.
func (h *Handler) joinFeishuOrganizationWorkspaces(ctx context.Context, user db.User) {
	if !user.FeishuUnionID.Valid || user.FeishuUnionID.String == "" {
		return
	}
	if h.seatCapacityEnabled() {
		// Seat-limited deployments admit members through invitations only.
		return
	}
	configs, err := h.Queries.ListEnabledFeishuOrgConfigs(ctx)
	if err != nil {
		slog.Warn("feishu org join: list configs failed", "error", err)
		return
	}
	directories := make(map[string]*lark.OrgSnapshot)
	for _, config := range configs {
		if !config.AutoSync {
			continue
		}
		// Membership is the cheap check; only load a directory for a
		// workspace the user is not already in.
		if _, err := h.Queries.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{UserID: user.ID, WorkspaceID: config.WorkspaceID}); err == nil {
			continue
		} else if !errors.Is(err, pgx.ErrNoRows) {
			slog.Warn("feishu org join: membership lookup failed", "workspace_id", uuidToString(config.WorkspaceID), "error", err)
			continue
		}
		key := feishuOrgConfigSource(config) + ":" + uuidToString(config.InstallationID)
		snapshot, ok := directories[key]
		if !ok {
			snapshot = h.feishuOrgJoinDirectory(ctx, config, user)
			directories[key] = snapshot
		}
		if snapshot == nil {
			continue
		}
		directoryUser, found := feishuorg.FindUser(*snapshot, user.FeishuUnionID.String, user.Email)
		if !found || !directoryUser.Active {
			continue
		}
		if err := h.joinFeishuOrgWorkspace(ctx, config, *snapshot, directoryUser, user); err != nil {
			slog.Warn("feishu org join: workspace join failed", "workspace_id", uuidToString(config.WorkspaceID), "user_id", uuidToString(user.ID), "error", err)
		}
	}
}

// feishuOrgJoinDirectory returns the source's directory when it may contain
// the user: for an installation, a tenant_key on both sides must agree. The
// login app is the app the user just signed in with. nil means skip.
func (h *Handler) feishuOrgJoinDirectory(ctx context.Context, config db.FeishuOrgConfig, user db.User) *lark.OrgSnapshot {
	if feishuOrgConfigSource(config) == feishuOrgSourceInstallation && h.LarkInstallations != nil && user.FeishuTenantKey.Valid && user.FeishuTenantKey.String != "" {
		installation, err := h.LarkInstallations.Get(ctx, config.InstallationID)
		if err != nil {
			return nil
		}
		if installation.TenantKey.Valid && installation.TenantKey.String != "" && installation.TenantKey.String != user.FeishuTenantKey.String {
			return nil
		}
	}
	directoryKey, err := feishuOrgDirectoryKey(config)
	if err != nil {
		return nil
	}
	_, snapshot, err := loadFeishuOrgDirectory(ctx, h.Queries, directoryKey)
	if err != nil {
		return nil
	}
	return &snapshot
}

func (h *Handler) feishuOrgMappings(ctx context.Context, q *db.Queries, workspaceID pgtype.UUID) ([]feishuorg.Mapping, error) {
	groups, err := q.ListFeishuOrgGroups(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	roleMappings, err := q.ListFeishuOrgRoleMappings(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	rolesByGroup := make(map[string]string, len(roleMappings))
	for _, mapping := range roleMappings {
		rolesByGroup[uuidToString(mapping.GroupID)] = mapping.Role
	}
	mappings := make([]feishuorg.Mapping, 0, len(groups))
	for _, group := range groups {
		if !group.Configured {
			continue
		}
		groupID := uuidToString(group.ID)
		mappings = append(mappings, feishuorg.Mapping{
			GroupID: groupID, Kind: group.Kind, ExternalID: group.ExternalID, ExternalName: group.ExternalName,
			MemberRole: rolesByGroup[groupID],
		})
	}
	return mappings, nil
}

func (h *Handler) joinFeishuOrgWorkspace(ctx context.Context, config db.FeishuOrgConfig, snapshot lark.OrgSnapshot, directoryUser lark.OrgUser, user db.User) error {
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	qtx := h.Queries.WithTx(tx)
	if err := qtx.LockFeishuOrgPermissionWrites(ctx, uuidToString(config.WorkspaceID)); err != nil {
		return err
	}
	if _, err := qtx.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{UserID: user.ID, WorkspaceID: config.WorkspaceID}); err == nil {
		return nil // already an active member; the sync keeps them current
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	mappings, err := h.feishuOrgMappings(ctx, qtx, config.WorkspaceID)
	if err != nil {
		return err
	}
	access := feishuorg.ResolveAccess(snapshot, mappings, directoryUser)
	if !access.Entitled() {
		return nil
	}
	// A role from a rule is recorded as managed so later syncs keep it in
	// step. Owner is capped to admin and left unmanaged: the next run then
	// plans the promotion as a role change an owner can apply by hand.
	role := access.Role
	managed := role != "" && role != "owner"
	switch role {
	case "":
		role = "member"
	case "owner":
		role = "admin"
	}
	var member db.Member
	disabled, err := qtx.GetDisabledMemberByUserAndWorkspace(ctx, db.GetDisabledMemberByUserAndWorkspaceParams{UserID: user.ID, WorkspaceID: config.WorkspaceID})
	switch {
	case err == nil:
		member, err = qtx.ReactivateMember(ctx, db.ReactivateMemberParams{ID: disabled.ID, Role: role})
	case errors.Is(err, pgx.ErrNoRows):
		member, err = qtx.CreateMember(ctx, db.CreateMemberParams{WorkspaceID: config.WorkspaceID, UserID: user.ID, Role: role})
	}
	if err != nil {
		return err
	}
	if managed {
		if _, err := qtx.SetFeishuOrgManagedRole(ctx, db.SetFeishuOrgManagedRoleParams{
			WorkspaceID: config.WorkspaceID, UserID: user.ID, FeishuManagedRole: pgtype.Text{String: role, Valid: true},
		}); err != nil {
			return err
		}
	}
	for _, groupID := range access.GroupIDs {
		if _, err := qtx.UpsertFeishuOrgMembership(ctx, db.UpsertFeishuOrgMembershipParams{
			WorkspaceID: config.WorkspaceID, GroupID: parseUUID(groupID), UserID: user.ID, Active: true,
		}); err != nil {
			return err
		}
	}
	// Joining through the organization is the user's first workspace in the
	// common case; skip the onboarding questionnaire like an accepted invite.
	onboarded, err := qtx.MarkUserOnboarded(ctx, user.ID)
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	workspaceID := uuidToString(config.WorkspaceID)
	h.MembershipCache.Invalidate(ctx, uuidToString(user.ID), workspaceID)
	payload := map[string]any{"member": h.memberWithUserResponse(member, onboarded)}
	if ws, err := h.Queries.GetWorkspace(ctx, config.WorkspaceID); err == nil {
		payload["workspace_name"] = ws.Name
	}
	h.publish(protocol.EventMemberAdded, workspaceID, "member", uuidToString(user.ID), payload)
	slog.Info("feishu org join: user joined workspace by organization rule", "workspace_id", workspaceID, "user_id", uuidToString(user.ID), "role", role)
	return nil
}
