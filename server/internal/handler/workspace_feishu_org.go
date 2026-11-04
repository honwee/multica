package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// inheritFeishuOrganization copies organization data from a workspace the
// creator can administer. Agent bindings and run history are deliberately not
// inherited because they belong to the source workspace.
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

	plan, err := json.Marshal(emptyFeishuOrgPlan())
	if err != nil {
		return fmt.Errorf("prepare inherited organization preview: %w", err)
	}
	if err := q.CloneLatestFeishuOrgSnapshot(ctx, db.CloneLatestFeishuOrgSnapshotParams{
		TargetWorkspaceID: workspaceID, SourceWorkspaceID: source.WorkspaceID,
		Revision: 1, Plan: plan, RequestedBy: userID,
	}); err != nil {
		return fmt.Errorf("inherit organization snapshot: %w", err)
	}
	return nil
}
