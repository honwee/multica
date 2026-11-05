package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/feishuorg"
	"github.com/multica-ai/multica/server/internal/integrations/lark"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

var (
	errFeishuOrgInsufficientRole = errors.New("feishu org: actor is not an active owner or admin")
	errFeishuOrgOwnerRequired    = errors.New("feishu org: plan changes owner access")
	errFeishuOrgRevisionChanged  = errors.New("feishu org: configuration changed since preview")
	errFeishuOrgSyncDisabled     = errors.New("feishu org: sync is disabled")
	errFeishuOrgNoActor          = errors.New("feishu org: no active owner or admin to act as")
)

const feishuOrgAutoSkipReason = "skipped: automatic sync never changes owner access; apply from the console as an owner"

type feishuOrgApplyOptions struct {
	// mode is recorded on the run: "apply" for a reviewed plan, "auto" for
	// a scheduled or event-driven run.
	mode string
	// source is the reviewed preview an "apply" run derives from.
	source *db.FeishuOrgSyncRun
	// automatic runs have no human reviewing them, so owner-affecting changes
	// are skipped instead of refused.
	automatic bool
	// directory is the version the plan is built from, recorded on the run.
	directory db.FeishuOrgDirectory
}

// applyFeishuOrgSync rebuilds the plan from the directory inside one
// transaction and applies it. The caller has already matched the actor's
// role at the HTTP layer; the role is checked again under the workspace's
// permission lock so a concurrent demotion cannot slip through.
func (h *Handler) applyFeishuOrgSync(ctx context.Context, actor feishuOrgActor, config db.FeishuOrgConfig, snapshot lark.OrgSnapshot, opts feishuOrgApplyOptions) (db.FeishuOrgSyncRun, error) {
	var sourceID pgtype.UUID
	if opts.source != nil {
		sourceID = opts.source.ID
	}
	plan := emptyFeishuOrgPlan()
	var tx pgx.Tx
	fail := func(cause error) (db.FeishuOrgSyncRun, error) {
		if tx != nil {
			_ = tx.Rollback(ctx)
		}
		_, _ = h.createFeishuOrgSyncRun(ctx, h.Queries, actor, opts.mode, "failed", config.Revision, plan, cause.Error(), sourceID, opts.directory.FetchedAt)
		return db.FeishuOrgSyncRun{}, cause
	}
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return fail(err)
	}
	defer tx.Rollback(ctx)
	qtx := h.Queries.WithTx(tx)
	if err := qtx.LockFeishuOrgPermissionWrites(ctx, uuidToString(actor.workspaceID)); err != nil {
		return fail(err)
	}
	currentMember, err := qtx.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{UserID: actor.userID, WorkspaceID: actor.workspaceID})
	if err != nil || !roleAllowed(currentMember.Role, "owner", "admin") {
		return db.FeishuOrgSyncRun{}, errFeishuOrgInsufficientRole
	}
	actor.member = currentMember
	currentConfig, err := qtx.GetFeishuOrgConfig(ctx, actor.workspaceID)
	if err != nil || currentConfig.Revision != config.Revision {
		return db.FeishuOrgSyncRun{}, errFeishuOrgRevisionChanged
	}
	if !currentConfig.Enabled {
		return db.FeishuOrgSyncRun{}, errFeishuOrgSyncDisabled
	}
	plan, err = h.buildFeishuOrgPlan(ctx, qtx, actor.workspaceID, snapshot)
	if err != nil {
		return fail(err)
	}
	if opts.automatic {
		plan, err = h.feishuOrgSkipOwnerChanges(ctx, qtx, actor.workspaceID, plan)
		if err != nil {
			return fail(err)
		}
	} else if actor.member.Role != "owner" {
		requiresOwner, err := h.feishuOrgPlanRequiresOwner(ctx, qtx, actor.workspaceID, plan)
		if err != nil {
			return fail(err)
		}
		if requiresOwner {
			return db.FeishuOrgSyncRun{}, errFeishuOrgOwnerRequired
		}
	}
	invalidateUsers := make(map[string]struct{})
	type disconnectSignal struct {
		userID   string
		memberID string
	}
	disconnects := make([]disconnectSignal, 0)
	for _, change := range plan.Changes {
		if change.Action == "skipped" {
			continue
		}
		userID := parseUUID(change.UserID)
		switch change.Action {
		case "member_disabled":
			member, err := qtx.DisableFeishuOrgMember(ctx, db.DisableFeishuOrgMemberParams{WorkspaceID: actor.workspaceID, UserID: userID})
			if err != nil {
				return fail(err)
			}
			invalidateUsers[change.UserID] = struct{}{}
			disconnects = append(disconnects, disconnectSignal{userID: change.UserID, memberID: uuidToString(member.ID)})
		case "member_restored":
			member, err := qtx.RestoreFeishuOrgMember(ctx, db.RestoreFeishuOrgMemberParams{WorkspaceID: actor.workspaceID, UserID: userID})
			if err != nil {
				return fail(err)
			}
			invalidateUsers[change.UserID] = struct{}{}
			disconnects = append(disconnects, disconnectSignal{userID: change.UserID, memberID: uuidToString(member.ID)})
		case "role_changed":
			if _, err := qtx.UpdateFeishuOrgMemberRole(ctx, db.UpdateFeishuOrgMemberRoleParams{WorkspaceID: actor.workspaceID, UserID: userID, Role: change.After}); err != nil {
				return fail(err)
			}
			invalidateUsers[change.UserID] = struct{}{}
		case "group_joined", "group_left":
			if _, err := qtx.UpsertFeishuOrgMembership(ctx, db.UpsertFeishuOrgMembershipParams{
				WorkspaceID: actor.workspaceID, GroupID: parseUUID(change.GroupID), UserID: userID, Active: change.Action == "group_joined",
			}); err != nil {
				return fail(err)
			}
		default:
			return fail(fmt.Errorf("unknown organization sync action %q", change.Action))
		}
	}
	for _, assignment := range plan.RoleAssignments {
		if !roleAllowed(assignment.Role, "owner", "admin", "member") {
			return fail(fmt.Errorf("invalid managed role %q", assignment.Role))
		}
		if _, err := qtx.UpdateFeishuOrgMemberRole(ctx, db.UpdateFeishuOrgMemberRoleParams{
			WorkspaceID: actor.workspaceID, UserID: parseUUID(assignment.UserID), Role: assignment.Role,
		}); err != nil {
			return fail(err)
		}
		invalidateUsers[assignment.UserID] = struct{}{}
	}
	// Agent changes are cleanup only: a team grant whose group left the
	// rules no longer admits anyone, so removing it does not need the agent
	// owner. Grants themselves are made from the agent access picker.
	for _, change := range plan.AgentChanges {
		switch change.Action {
		case "agent_revoked":
			if err := qtx.DeleteAgentInvocationTarget(ctx, db.DeleteAgentInvocationTargetParams{
				AgentID: parseUUID(change.AgentID), TargetType: invocationTargetTeam, TargetID: parseUUID(change.GroupID),
			}); err != nil {
				return fail(err)
			}
		default:
			return fail(fmt.Errorf("unknown organization agent action %q", change.Action))
		}
	}
	if err := qtx.ApplyFeishuOrgGroupStates(ctx, actor.workspaceID); err != nil {
		return fail(err)
	}
	run, err := h.createFeishuOrgSyncRun(ctx, qtx, actor, opts.mode, "completed", config.Revision, plan, "", sourceID, opts.directory.FetchedAt)
	if err != nil {
		return fail(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fail(err)
	}
	workspaceID := uuidToString(actor.workspaceID)
	for userID := range invalidateUsers {
		h.MembershipCache.Invalidate(ctx, userID, workspaceID)
	}
	for _, signal := range disconnects {
		h.Hub.DisconnectMember(workspaceID, signal.userID, signal.memberID)
	}
	return run, nil
}

// feishuOrgSkipOwnerChanges turns every owner-affecting change into a skipped
// entry so an unattended run never grants, removes, or disables an owner.
func (h *Handler) feishuOrgSkipOwnerChanges(ctx context.Context, q *db.Queries, workspaceID pgtype.UUID, plan feishuorg.Plan) (feishuorg.Plan, error) {
	members, err := q.ListFeishuOrgMemberIdentities(ctx, workspaceID)
	if err != nil {
		return plan, err
	}
	roles := feishuOrgMemberRoles(members)
	// Owners whose disable or restore is skipped keep their membership state
	// as it is: applying their group changes would either strip access from
	// a live owner or activate groups for a still-disabled one.
	frozenMembership := make(map[string]struct{})
	for i := range plan.Changes {
		change := &plan.Changes[i]
		if change.Action == "skipped" || !feishuOrgChangeAffectsOwner(*change, roles) {
			continue
		}
		if change.Action == "member_disabled" || change.Action == "member_restored" {
			frozenMembership[change.UserID] = struct{}{}
		}
		change.Reason = change.Action + " " + feishuOrgAutoSkipReason
		change.Action = "skipped"
	}
	kept := plan.Changes[:0]
	for _, change := range plan.Changes {
		if _, frozen := frozenMembership[change.UserID]; frozen && (change.Action == "group_left" || change.Action == "group_joined") {
			continue
		}
		kept = append(kept, change)
	}
	plan.Changes = kept
	assignments := plan.RoleAssignments[:0]
	for _, assignment := range plan.RoleAssignments {
		if feishuOrgAssignmentAffectsOwner(assignment, roles) {
			continue
		}
		assignments = append(assignments, assignment)
	}
	plan.RoleAssignments = assignments
	return plan, nil
}

// SyncFeishuOrganizations refreshes every enabled source's directory from
// Feishu and applies the plan for each workspace that opted into automatic
// sync. It returns how many workspaces were applied. Failures are logged per
// source or workspace so one broken tenant does not stop the others; the
// first error is returned for the job audit row.
func (h *Handler) SyncFeishuOrganizations(ctx context.Context) (int, error) {
	configs, err := h.Queries.ListEnabledFeishuOrgConfigs(ctx)
	if err != nil {
		return 0, err
	}
	if len(configs) == 0 {
		return 0, nil
	}
	type refreshResult struct {
		directory db.FeishuOrgDirectory
		snapshot  lark.OrgSnapshot
		err       error
	}
	// One fetch per source, successful or not: a tenant whose app lost its
	// scopes must not be crawled once per workspace sharing it.
	refreshed := make(map[string]refreshResult)
	var firstErr error
	applied := 0
	for _, config := range configs {
		sourceKey := feishuOrgConfigSource(config) + ":" + uuidToString(config.InstallationID)
		result, ok := refreshed[sourceKey]
		if !ok {
			result.directory, result.snapshot, result.err = h.refreshFeishuOrgDirectory(ctx, config, pgtype.UUID{})
			refreshed[sourceKey] = result
			if result.err != nil {
				slog.Warn("feishu org auto sync: directory refresh failed", "source", feishuOrgConfigSource(config), "installation_id", uuidToString(config.InstallationID), "error", result.err)
				if firstErr == nil {
					firstErr = result.err
				}
			}
		}
		if result.err != nil || !config.AutoSync {
			continue
		}
		if _, err := h.autoApplyFeishuOrg(ctx, config, result.directory, result.snapshot); err != nil {
			slog.Warn("feishu org auto sync: apply failed", "workspace_id", uuidToString(config.WorkspaceID), "error", err)
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		applied++
	}
	return applied, firstErr
}

// SyncFeishuOrganizationInstallation refreshes the directory of the app an
// installation's contact event arrived on and auto-applies every workspace
// reading it: workspaces configured on that installation, or on the login
// app when the installation is the login app. The Lark connector calls it
// when Feishu reports a contact change.
func (h *Handler) SyncFeishuOrganizationInstallation(ctx context.Context, installation lark.Installation) error {
	configs, err := h.Queries.ListEnabledFeishuOrgConfigs(ctx)
	if err != nil {
		return err
	}
	loginApp, loginAppConfigured := feishuLoginApp()
	isLoginApp := loginAppConfigured && installation.AppID == loginApp.AppID
	// A bot installed for messaging only has no directory to keep; skip the
	// contact crawl unless some workspace syncs from this app.
	relevant := configs[:0]
	for _, config := range configs {
		switch feishuOrgConfigSource(config) {
		case feishuOrgSourceInstallation:
			if config.InstallationID == installation.ID {
				relevant = append(relevant, config)
			}
		case feishuOrgSourceLoginApp:
			if isLoginApp {
				relevant = append(relevant, config)
			}
		}
	}
	if len(relevant) == 0 {
		return nil
	}
	// Every relevant config reads the same app; the first one names the
	// source to refresh.
	directory, snapshot, err := h.refreshFeishuOrgDirectory(ctx, relevant[0], pgtype.UUID{})
	if err != nil {
		return err
	}
	var firstErr error
	for _, config := range relevant {
		if !config.AutoSync {
			continue
		}
		if _, err := h.autoApplyFeishuOrg(ctx, config, directory, snapshot); err != nil {
			slog.Warn("feishu org event sync: apply failed", "workspace_id", uuidToString(config.WorkspaceID), "error", err)
			if firstErr == nil {
				firstErr = err
			}
		}
	}
	return firstErr
}

// refreshFeishuOrgDirectory fetches the organization behind a config's
// source and stores it as the shared directory. An installation source must
// be active; shared access is validated by the configs that point at it.
func (h *Handler) refreshFeishuOrgDirectory(ctx context.Context, config db.FeishuOrgConfig, fetchedBy pgtype.UUID) (db.FeishuOrgDirectory, lark.OrgSnapshot, error) {
	none := db.FeishuOrgDirectory{}
	if h.LarkAPIClient == nil {
		return none, lark.OrgSnapshot{}, errors.New("feishu org: lark integration not configured")
	}
	orgClient, ok := h.LarkAPIClient.(lark.OrgAPIClient)
	if !ok {
		return none, lark.OrgSnapshot{}, errors.New("feishu org: lark organization API not configured")
	}
	credentials, directoryKey, err := h.feishuOrgSourceCredentials(ctx, config)
	if err != nil {
		return none, lark.OrgSnapshot{}, err
	}
	fetchCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	snapshot, err := orgClient.FetchOrganization(fetchCtx, credentials)
	if err != nil {
		return none, lark.OrgSnapshot{}, err
	}
	if !snapshot.Complete {
		return none, lark.OrgSnapshot{}, errors.New("feishu org: fetched directory is incomplete")
	}
	snapshotJSON, err := json.Marshal(snapshot)
	if err != nil {
		return none, lark.OrgSnapshot{}, err
	}
	directory, err := h.Queries.UpsertFeishuOrgDirectory(ctx, db.UpsertFeishuOrgDirectoryParams{
		InstallationID: directoryKey, Snapshot: snapshotJSON, FetchedBy: fetchedBy,
	})
	if err != nil {
		return none, lark.OrgSnapshot{}, err
	}
	return directory, snapshot, nil
}

// autoApplyFeishuOrg applies the current plan for one workspace on behalf of
// the admin who last saved the configuration, falling back to the earliest
// active owner. The run is recorded with mode "auto".
func (h *Handler) autoApplyFeishuOrg(ctx context.Context, config db.FeishuOrgConfig, directory db.FeishuOrgDirectory, snapshot lark.OrgSnapshot) (db.FeishuOrgSyncRun, error) {
	actorID, err := h.feishuOrgAutomaticActor(ctx, config)
	if err != nil {
		return db.FeishuOrgSyncRun{}, err
	}
	actor := feishuOrgActor{workspaceID: config.WorkspaceID, userID: actorID}
	return h.applyFeishuOrgSync(ctx, actor, config, snapshot, feishuOrgApplyOptions{mode: "auto", automatic: true, directory: directory})
}

func (h *Handler) feishuOrgAutomaticActor(ctx context.Context, config db.FeishuOrgConfig) (pgtype.UUID, error) {
	if config.UpdatedBy.Valid {
		member, err := h.Queries.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{UserID: config.UpdatedBy, WorkspaceID: config.WorkspaceID})
		if err == nil && roleAllowed(member.Role, "owner", "admin") {
			return config.UpdatedBy, nil
		}
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return pgtype.UUID{}, err
		}
	}
	owners, err := h.Queries.ListActiveOwnerUserIDs(ctx, config.WorkspaceID)
	if err != nil {
		return pgtype.UUID{}, err
	}
	if len(owners) == 0 {
		return pgtype.UUID{}, errFeishuOrgNoActor
	}
	return owners[0], nil
}
