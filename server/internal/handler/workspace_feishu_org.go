package handler

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// inheritFeishuOrganization copies organization rules from a workspace the
// creator can administer. The directory itself is shared through the
// installation, and run history stays with the source workspace.
func inheritFeishuOrganization(ctx context.Context, q *db.Queries, userID, workspaceID pgtype.UUID) error {
	source, err := q.GetFeishuOrgBootstrapSource(ctx, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("select organization inheritance source: %w", err)
	}

	if _, err := q.UpsertFeishuOrgConfig(ctx, db.UpsertFeishuOrgConfigParams{
		WorkspaceID: workspaceID, InstallationID: source.InstallationID, Enabled: source.Enabled,
		AutoSync: source.AutoSync, UpdatedBy: userID,
	}); err != nil {
		return fmt.Errorf("inherit organization config: %w", err)
	}
	if err := q.CloneFeishuOrgGroups(ctx, db.CloneFeishuOrgGroupsParams{
		TargetWorkspaceID: workspaceID, SourceWorkspaceID: source.WorkspaceID,
	}); err != nil {
		return fmt.Errorf("inherit organization groups: %w", err)
	}
	if err := q.CloneFeishuOrgRoleMappings(ctx, db.CloneFeishuOrgRoleMappingsParams{
		TargetWorkspaceID: workspaceID, SourceWorkspaceID: source.WorkspaceID,
	}); err != nil {
		return fmt.Errorf("inherit organization role mappings: %w", err)
	}
	if err := q.CloneFeishuOrgMemberships(ctx, db.CloneFeishuOrgMembershipsParams{
		TargetWorkspaceID: workspaceID, SourceWorkspaceID: source.WorkspaceID,
	}); err != nil {
		return fmt.Errorf("inherit organization memberships: %w", err)
	}

	return nil
}
