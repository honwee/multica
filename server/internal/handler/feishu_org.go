package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/feishuorg"
	"github.com/multica-ai/multica/server/internal/integrations/lark"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

var feishuOrgRequirements = []string{
	"Grant the required scopes and publish a new app version.",
	"Include every required department and user in the app's contact visibility scope.",
}

type LarkOrganizationConfigResponse struct {
	InstallationID string `json:"installation_id"`
	Enabled        bool   `json:"enabled"`
	// AutoSync applies the plan on a schedule and whenever the directory
	// changes, without a manual preview and apply.
	AutoSync  bool   `json:"auto_sync"`
	Revision  int64  `json:"revision"`
	UpdatedAt string `json:"updated_at"`
}

// LarkOrganizationMappingResponse is one organization rule. Agent access is
// not part of a rule: owners grant their agents to an applied group from the
// agent access picker, and the sync only revokes grants whose group is gone.
type LarkOrganizationMappingResponse struct {
	Kind         string  `json:"kind"`
	ExternalID   string  `json:"external_id"`
	ExternalName string  `json:"external_name"`
	MemberRole   *string `json:"member_role"`
}

type LarkOrganizationSyncRunResponse struct {
	ID             string         `json:"id"`
	WorkspaceID    string         `json:"workspace_id"`
	Mode           string         `json:"mode"`
	Status         string         `json:"status"`
	Revision       int64          `json:"revision"`
	Plan           feishuorg.Plan `json:"plan"`
	Error          string         `json:"error"`
	RequestedBy    string         `json:"requested_by"`
	ReplayedFromID *string        `json:"replayed_from_id,omitempty"`
	CreatedAt      string         `json:"created_at"`
	CompletedAt    *string        `json:"completed_at,omitempty"`
}

type LarkOrganizationResponse struct {
	Config         *LarkOrganizationConfigResponse   `json:"config"`
	Mappings       []LarkOrganizationMappingResponse `json:"mappings"`
	RequiredScopes []string                          `json:"required_scopes"`
	Requirements   []string                          `json:"requirements"`
	SyncRuns       []LarkOrganizationSyncRunResponse `json:"sync_runs"`
	Catalog        *LarkOrganizationCatalogResponse  `json:"catalog,omitempty"`
}

type UpdateLarkOrganizationRequest struct {
	InstallationID string                            `json:"installation_id"`
	Enabled        bool                              `json:"enabled"`
	AutoSync       bool                              `json:"auto_sync"`
	Mappings       []LarkOrganizationMappingResponse `json:"mappings"`
}

type feishuOrgActor struct {
	workspaceID pgtype.UUID
	userID      pgtype.UUID
	member      db.Member
}

func emptyFeishuOrgPlan() feishuorg.Plan {
	return feishuorg.Plan{Changes: []feishuorg.Change{}, AgentChanges: []feishuorg.AgentChange{}, Warnings: []string{}}
}

func (h *Handler) feishuOrgMutationActor(w http.ResponseWriter, r *http.Request) (feishuOrgActor, bool) {
	workspaceID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "workspace id")
	if !ok {
		return feishuOrgActor{}, false
	}
	userID, ok := parseUUIDOrBadRequest(w, requestUserID(r), "user id")
	if !ok {
		return feishuOrgActor{}, false
	}
	member, ok := h.workspaceMember(w, r, uuidToString(workspaceID))
	if !ok {
		return feishuOrgActor{}, false
	}
	if !roleAllowed(member.Role, "owner", "admin") {
		writeError(w, http.StatusForbidden, "insufficient permissions")
		return feishuOrgActor{}, false
	}
	return feishuOrgActor{workspaceID: workspaceID, userID: userID, member: member}, true
}

func (h *Handler) GetLarkOrganization(w http.ResponseWriter, r *http.Request) {
	actor, ok := h.feishuOrgMutationActor(w, r)
	if !ok {
		return
	}
	response, err := h.loadLarkOrganizationResponse(r.Context(), actor.workspaceID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load organization sync configuration")
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (h *Handler) loadLarkOrganizationResponse(ctx context.Context, workspaceID pgtype.UUID) (LarkOrganizationResponse, error) {
	response := LarkOrganizationResponse{
		Mappings:       []LarkOrganizationMappingResponse{},
		RequiredScopes: append([]string{}, lark.RequiredOrgScopes...),
		Requirements:   append([]string{}, feishuOrgRequirements...),
		SyncRuns:       []LarkOrganizationSyncRunResponse{},
	}
	config, err := h.Queries.GetFeishuOrgConfig(ctx, workspaceID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return response, err
	}
	if err == nil {
		response.Config = &LarkOrganizationConfigResponse{
			InstallationID: uuidToString(config.InstallationID),
			Enabled:        config.Enabled,
			AutoSync:       config.AutoSync,
			Revision:       config.Revision,
			UpdatedAt:      timestampToString(config.UpdatedAt),
		}
	}
	groups, err := h.Queries.ListFeishuOrgGroups(ctx, workspaceID)
	if err != nil {
		return response, err
	}
	roleMappings, err := h.Queries.ListFeishuOrgRoleMappings(ctx, workspaceID)
	if err != nil {
		return response, err
	}
	rolesByGroup := make(map[string]string, len(roleMappings))
	for _, mapping := range roleMappings {
		rolesByGroup[uuidToString(mapping.GroupID)] = mapping.Role
	}
	for _, group := range groups {
		if !group.Configured {
			continue
		}
		groupID := uuidToString(group.ID)
		mapping := LarkOrganizationMappingResponse{
			Kind:         group.Kind,
			ExternalID:   group.ExternalID,
			ExternalName: group.ExternalName,
		}
		if role := rolesByGroup[groupID]; role != "" {
			mapping.MemberRole = &role
		}
		response.Mappings = append(response.Mappings, mapping)
	}
	runs, err := h.Queries.ListFeishuOrgSyncRuns(ctx, workspaceID)
	if err != nil {
		return response, err
	}
	for _, run := range runs {
		converted, err := larkOrganizationSyncRunResponse(run)
		if err != nil {
			return response, err
		}
		response.SyncRuns = append(response.SyncRuns, converted)
	}
	if response.Config != nil {
		directory, snapshot, err := loadFeishuOrgDirectory(ctx, h.Queries, config.InstallationID)
		if err != nil && !errors.Is(err, errFeishuOrgDirectoryMissing) {
			return response, err
		}
		if err == nil {
			catalog, err := h.buildLarkOrganizationCatalog(ctx, workspaceID, directory, snapshot)
			if err != nil {
				return response, err
			}
			response.Catalog = catalog
		}
	}
	return response, nil
}

var errFeishuOrgDirectoryMissing = errors.New("organization directory has not been fetched")

// loadFeishuOrgDirectory returns the installation's fetched directory. An
// incomplete snapshot counts as missing: nothing may plan against it.
func loadFeishuOrgDirectory(ctx context.Context, q *db.Queries, installationID pgtype.UUID) (db.FeishuOrgDirectory, lark.OrgSnapshot, error) {
	directory, err := q.GetFeishuOrgDirectory(ctx, installationID)
	if errors.Is(err, pgx.ErrNoRows) {
		return db.FeishuOrgDirectory{}, lark.OrgSnapshot{}, errFeishuOrgDirectoryMissing
	}
	if err != nil {
		return db.FeishuOrgDirectory{}, lark.OrgSnapshot{}, err
	}
	var snapshot lark.OrgSnapshot
	if err := json.Unmarshal(directory.Snapshot, &snapshot); err != nil {
		return db.FeishuOrgDirectory{}, lark.OrgSnapshot{}, fmt.Errorf("decode organization directory: %w", err)
	}
	if !snapshot.Complete {
		return db.FeishuOrgDirectory{}, lark.OrgSnapshot{}, errFeishuOrgDirectoryMissing
	}
	return directory, snapshot, nil
}

func larkOrganizationSyncRunResponse(row db.FeishuOrgSyncRun) (LarkOrganizationSyncRunResponse, error) {
	plan := emptyFeishuOrgPlan()
	if len(bytes.TrimSpace(row.Plan)) != 0 {
		if err := json.Unmarshal(row.Plan, &plan); err != nil {
			return LarkOrganizationSyncRunResponse{}, err
		}
	}
	if plan.Changes == nil {
		plan.Changes = []feishuorg.Change{}
	}
	if plan.AgentChanges == nil {
		plan.AgentChanges = []feishuorg.AgentChange{}
	}
	if plan.Warnings == nil {
		plan.Warnings = []string{}
	}
	response := LarkOrganizationSyncRunResponse{
		ID:             uuidToString(row.ID),
		WorkspaceID:    uuidToString(row.WorkspaceID),
		Mode:           row.Mode,
		Status:         row.Status,
		Revision:       row.Revision,
		Plan:           plan,
		RequestedBy:    uuidToString(row.RequestedBy),
		ReplayedFromID: uuidToPtr(row.ReplayedFromID),
		CreatedAt:      timestampToString(row.CreatedAt),
		CompletedAt:    timestampToPtr(row.CompletedAt),
	}
	if row.Error.Valid {
		response.Error = row.Error.String
	}
	return response, nil
}

func (h *Handler) UpdateLarkOrganization(w http.ResponseWriter, r *http.Request) {
	actor, ok := h.feishuOrgMutationActor(w, r)
	if !ok {
		return
	}
	if h.LarkInstallations == nil {
		writeFeatureDisabled(w, "lark_not_configured", "lark integration not configured")
		return
	}
	var request UpdateLarkOrganizationRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	installationID, ok := parseUUIDOrBadRequest(w, request.InstallationID, "installation_id")
	if !ok {
		return
	}
	installation, err := h.LarkInstallations.GetOrganizationInstallation(r.Context(), installationID, actor.workspaceID)
	if errors.Is(err, lark.ErrInstallationNotFound) {
		writeError(w, http.StatusNotFound, "lark installation not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load installation")
		return
	}
	if lark.InstallationStatus(installation.Status) != lark.InstallationActive {
		writeError(w, http.StatusBadRequest, "lark installation must be active")
		return
	}

	seenGroups := make(map[string]struct{}, len(request.Mappings))
	requiresOwner := false
	for i := range request.Mappings {
		mapping := &request.Mappings[i]
		mapping.Kind = strings.TrimSpace(mapping.Kind)
		mapping.ExternalID = strings.TrimSpace(mapping.ExternalID)
		mapping.ExternalName = strings.TrimSpace(mapping.ExternalName)
		if mapping.Kind != "department" && mapping.Kind != "job_title" && mapping.Kind != "user" {
			writeError(w, http.StatusBadRequest, "mapping kind must be 'department', 'job_title', or 'user'")
			return
		}
		if mapping.ExternalID == "" {
			writeError(w, http.StatusBadRequest, "mapping external_id is required")
			return
		}
		groupKey := mapping.Kind + "\x00" + mapping.ExternalID
		if _, duplicate := seenGroups[groupKey]; duplicate {
			writeError(w, http.StatusBadRequest, "duplicate organization mapping")
			return
		}
		seenGroups[groupKey] = struct{}{}
		if mapping.MemberRole != nil {
			role := strings.TrimSpace(*mapping.MemberRole)
			if !roleAllowed(role, "owner", "admin", "member") {
				writeError(w, http.StatusBadRequest, "mapping member_role must be 'owner', 'admin', or 'member'")
				return
			}
			mapping.MemberRole = &role
			requiresOwner = requiresOwner || role == "owner"
		}
	}
	if requiresOwner && actor.member.Role != "owner" {
		writeError(w, http.StatusForbidden, "only a workspace owner can configure owner role mappings")
		return
	}

	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save organization sync configuration")
		return
	}
	defer tx.Rollback(r.Context())
	qtx := h.Queries.WithTx(tx)
	if err := qtx.LockFeishuOrgPermissionWrites(r.Context(), uuidToString(actor.workspaceID)); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save organization sync configuration")
		return
	}
	currentMember, err := qtx.GetMemberByUserAndWorkspace(r.Context(), db.GetMemberByUserAndWorkspaceParams{UserID: actor.userID, WorkspaceID: actor.workspaceID})
	if err != nil || !roleAllowed(currentMember.Role, "owner", "admin") {
		writeError(w, http.StatusForbidden, "insufficient permissions")
		return
	}
	actor.member = currentMember
	if requiresOwner && actor.member.Role != "owner" {
		writeError(w, http.StatusForbidden, "only a workspace owner can configure owner role mappings")
		return
	}
	if _, err := qtx.UpsertFeishuOrgConfig(r.Context(), db.UpsertFeishuOrgConfigParams{
		WorkspaceID: actor.workspaceID, InstallationID: installationID, Enabled: request.Enabled,
		AutoSync: request.AutoSync, UpdatedBy: actor.userID,
	}); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save organization sync configuration")
		return
	}
	if err := qtx.DeleteFeishuOrgRoleMappings(r.Context(), actor.workspaceID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save organization sync configuration")
		return
	}
	configuredGroupIDs := make([]pgtype.UUID, 0, len(request.Mappings))
	for _, mapping := range request.Mappings {
		group, err := qtx.UpsertFeishuOrgGroup(r.Context(), db.UpsertFeishuOrgGroupParams{
			WorkspaceID: actor.workspaceID, Kind: mapping.Kind, ExternalID: mapping.ExternalID,
			ExternalName: mapping.ExternalName,
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to save organization sync configuration")
			return
		}
		configuredGroupIDs = append(configuredGroupIDs, group.ID)
		if mapping.MemberRole != nil {
			if _, err := qtx.CreateFeishuOrgRoleMapping(r.Context(), db.CreateFeishuOrgRoleMappingParams{
				WorkspaceID: actor.workspaceID, GroupID: group.ID, Role: *mapping.MemberRole,
			}); err != nil {
				writeError(w, http.StatusInternalServerError, "failed to save organization sync configuration")
				return
			}
		}
	}
	if err := qtx.DeactivateFeishuOrgGroupsNotIn(r.Context(), db.DeactivateFeishuOrgGroupsNotInParams{
		WorkspaceID: actor.workspaceID, Ids: configuredGroupIDs,
	}); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save organization sync configuration")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save organization sync configuration")
		return
	}
	response, err := h.loadLarkOrganizationResponse(r.Context(), actor.workspaceID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load organization sync configuration")
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (h *Handler) PreviewLarkOrganization(w http.ResponseWriter, r *http.Request) {
	actor, ok := h.feishuOrgMutationActor(w, r)
	if !ok {
		return
	}
	config, ok := h.feishuOrgConfigForRun(w, r, actor.workspaceID)
	if !ok {
		return
	}
	if !config.Enabled {
		writeError(w, http.StatusConflict, "organization sync must be enabled")
		return
	}
	installation, ok := h.feishuOrgActiveInstallation(w, r, actor.workspaceID, config.InstallationID)
	if !ok {
		return
	}
	orgClient, ok := h.LarkAPIClient.(lark.OrgAPIClient)
	if !ok {
		writeFeatureDisabled(w, "lark_org_not_configured", "lark organization API is not configured")
		return
	}

	fail := func(cause error) {
		// A client-side timeout or disconnect must not erase the failed preview's
		// audit record. Keep the detached write bounded as well.
		auditCtx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Second)
		defer cancel()
		run, err := h.createFeishuOrgSyncRun(auditCtx, h.Queries, actor, "preview", "failed", config.Revision, emptyFeishuOrgPlan(), cause.Error(), pgtype.UUID{})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to audit organization preview")
			return
		}
		response, err := larkOrganizationSyncRunResponse(run)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to encode organization preview")
			return
		}
		writeJSON(w, http.StatusOK, response)
	}

	secret, err := h.LarkInstallations.DecryptAppSecret(installation)
	if err != nil {
		fail(err)
		return
	}
	snapshot, err := orgClient.FetchOrganization(r.Context(), lark.InstallationCredentials{
		AppID: installation.AppID, AppSecret: secret, TenantKey: installation.TenantKey.String, Region: lark.Region(installation.Region),
	})
	if err != nil {
		fail(err)
		return
	}
	snapshotJSON, err := json.Marshal(snapshot)
	if err != nil {
		fail(err)
		return
	}
	if _, err := h.Queries.UpsertFeishuOrgDirectory(r.Context(), db.UpsertFeishuOrgDirectoryParams{
		InstallationID: installation.ID, Snapshot: snapshotJSON, FetchedBy: actor.userID,
	}); err != nil {
		fail(err)
		return
	}
	plan, err := h.buildFeishuOrgPlan(r.Context(), h.Queries, actor.workspaceID, snapshot)
	if err != nil {
		fail(err)
		return
	}
	run, err := h.createFeishuOrgSyncRun(r.Context(), h.Queries, actor, "preview", "preview", config.Revision, plan, "", pgtype.UUID{})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save organization preview")
		return
	}
	response, err := larkOrganizationSyncRunResponse(run)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to encode organization preview")
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (h *Handler) ReplayLarkOrganizationSync(w http.ResponseWriter, r *http.Request) {
	actor, source, ok := h.feishuOrgSourceRun(w, r)
	if !ok {
		return
	}
	config, ok := h.feishuOrgConfigForRun(w, r, actor.workspaceID)
	if !ok {
		return
	}
	if !config.Enabled {
		writeError(w, http.StatusConflict, "organization sync must be enabled")
		return
	}
	snapshot, ok := h.feishuOrgDirectorySnapshot(w, r, config.InstallationID)
	if !ok {
		return
	}
	plan, err := h.buildFeishuOrgPlan(r.Context(), h.Queries, actor.workspaceID, snapshot)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to recalculate organization preview")
		return
	}
	run, err := h.createFeishuOrgSyncRun(r.Context(), h.Queries, actor, "replay", "preview", config.Revision, plan, "", source.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save organization replay")
		return
	}
	response, err := larkOrganizationSyncRunResponse(run)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to encode organization replay")
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (h *Handler) ApplyLarkOrganizationSync(w http.ResponseWriter, r *http.Request) {
	actor, source, ok := h.feishuOrgSourceRun(w, r)
	if !ok {
		return
	}
	if source.Status != "preview" {
		writeError(w, http.StatusConflict, "organization sync run is not applicable")
		return
	}
	config, ok := h.feishuOrgConfigForRun(w, r, actor.workspaceID)
	if !ok {
		return
	}
	if config.Revision != source.Revision {
		writeError(w, http.StatusConflict, "organization sync configuration changed since preview")
		return
	}
	snapshot, ok := h.feishuOrgDirectorySnapshot(w, r, config.InstallationID)
	if !ok {
		return
	}
	run, err := h.applyFeishuOrgSync(r.Context(), actor, config, snapshot, feishuOrgApplyOptions{mode: "apply", source: &source})
	switch {
	case errors.Is(err, errFeishuOrgInsufficientRole):
		writeError(w, http.StatusForbidden, "insufficient permissions")
		return
	case errors.Is(err, errFeishuOrgOwnerRequired):
		writeError(w, http.StatusForbidden, "only a workspace owner can change owner access")
		return
	case errors.Is(err, errFeishuOrgRevisionChanged):
		writeError(w, http.StatusConflict, "organization sync configuration changed since preview")
		return
	case errors.Is(err, errFeishuOrgSyncDisabled):
		writeError(w, http.StatusConflict, "organization sync must be enabled")
		return
	case err != nil:
		writeError(w, http.StatusInternalServerError, "failed to apply organization sync")
		return
	}
	response, err := larkOrganizationSyncRunResponse(run)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to encode applied organization sync")
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (h *Handler) feishuOrgPlanRequiresOwner(ctx context.Context, q *db.Queries, workspaceID pgtype.UUID, plan feishuorg.Plan) (bool, error) {
	members, err := q.ListFeishuOrgMemberIdentities(ctx, workspaceID)
	if err != nil {
		return false, err
	}
	roles := make(map[string]string, len(members))
	for _, member := range members {
		roles[uuidToString(member.UserID)] = member.Role
	}
	for _, change := range plan.Changes {
		if change.Action == "skipped" {
			continue
		}
		switch change.Action {
		case "member_disabled", "member_restored":
			if roles[change.UserID] == "owner" {
				return true, nil
			}
		case "role_changed":
			if change.Before == "owner" || change.After == "owner" {
				return true, nil
			}
		}
	}
	for _, assignment := range plan.RoleAssignments {
		if assignment.Role == "owner" {
			return true, nil
		}
	}
	return false, nil
}

func (h *Handler) feishuOrgConfigForRun(w http.ResponseWriter, r *http.Request, workspaceID pgtype.UUID) (db.FeishuOrgConfig, bool) {
	config, err := h.Queries.GetFeishuOrgConfig(r.Context(), workspaceID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusConflict, "organization sync is not configured")
		return db.FeishuOrgConfig{}, false
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load organization sync configuration")
		return db.FeishuOrgConfig{}, false
	}
	return config, true
}

func (h *Handler) feishuOrgActiveInstallation(w http.ResponseWriter, r *http.Request, workspaceID, installationID pgtype.UUID) (lark.Installation, bool) {
	if h.LarkInstallations == nil {
		writeFeatureDisabled(w, "lark_not_configured", "lark integration not configured")
		return lark.Installation{}, false
	}
	installation, err := h.LarkInstallations.GetOrganizationInstallation(r.Context(), installationID, workspaceID)
	if errors.Is(err, lark.ErrInstallationNotFound) {
		writeError(w, http.StatusNotFound, "lark installation not found")
		return lark.Installation{}, false
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load installation")
		return lark.Installation{}, false
	}
	if lark.InstallationStatus(installation.Status) != lark.InstallationActive {
		writeError(w, http.StatusConflict, "lark installation must be active")
		return lark.Installation{}, false
	}
	return installation, true
}

func (h *Handler) feishuOrgSourceRun(w http.ResponseWriter, r *http.Request) (feishuOrgActor, db.FeishuOrgSyncRun, bool) {
	actor, ok := h.feishuOrgMutationActor(w, r)
	if !ok {
		return feishuOrgActor{}, db.FeishuOrgSyncRun{}, false
	}
	runID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "runId"), "run id")
	if !ok {
		return feishuOrgActor{}, db.FeishuOrgSyncRun{}, false
	}
	source, err := h.Queries.GetFeishuOrgSyncRunInWorkspace(r.Context(), db.GetFeishuOrgSyncRunInWorkspaceParams{ID: runID, WorkspaceID: actor.workspaceID})
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "organization sync run not found")
		return feishuOrgActor{}, db.FeishuOrgSyncRun{}, false
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load organization sync run")
		return feishuOrgActor{}, db.FeishuOrgSyncRun{}, false
	}
	if source.Mode != "preview" && source.Mode != "replay" {
		writeError(w, http.StatusConflict, "organization sync run cannot be applied or replayed")
		return feishuOrgActor{}, db.FeishuOrgSyncRun{}, false
	}
	return actor, source, true
}

// feishuOrgDirectorySnapshot loads the directory a replay or apply plans
// against. Both work from the current directory, never from Feishu directly.
func (h *Handler) feishuOrgDirectorySnapshot(w http.ResponseWriter, r *http.Request, installationID pgtype.UUID) (lark.OrgSnapshot, bool) {
	_, snapshot, err := loadFeishuOrgDirectory(r.Context(), h.Queries, installationID)
	if errors.Is(err, errFeishuOrgDirectoryMissing) {
		writeError(w, http.StatusConflict, "organization directory has not been fetched; run a preview first")
		return lark.OrgSnapshot{}, false
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load organization directory")
		return lark.OrgSnapshot{}, false
	}
	return snapshot, true
}

func (h *Handler) buildFeishuOrgPlan(ctx context.Context, q *db.Queries, workspaceID pgtype.UUID, snapshot lark.OrgSnapshot) (feishuorg.Plan, error) {
	groups, err := q.ListFeishuOrgGroups(ctx, workspaceID)
	if err != nil {
		return feishuorg.Plan{}, err
	}
	roleMappings, err := q.ListFeishuOrgRoleMappings(ctx, workspaceID)
	if err != nil {
		return feishuorg.Plan{}, err
	}
	membershipRows, err := q.ListFeishuOrgMemberships(ctx, workspaceID)
	if err != nil {
		return feishuorg.Plan{}, err
	}
	memberRows, err := q.ListFeishuOrgMemberIdentities(ctx, workspaceID)
	if err != nil {
		return feishuorg.Plan{}, err
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
	trackedUsers := make(map[string]struct{})
	memberships := make([]feishuorg.Membership, 0, len(membershipRows))
	for _, row := range membershipRows {
		userID := uuidToString(row.UserID)
		trackedUsers[userID] = struct{}{}
		memberships = append(memberships, feishuorg.Membership{GroupID: uuidToString(row.GroupID), UserID: userID, Active: row.Active})
	}
	members := feishuOrgMemberInputs(memberRows)
	for i, row := range memberRows {
		_, hasMembership := trackedUsers[uuidToString(row.UserID)]
		members[i].Tracked = members[i].ManagedRole != "" || row.DisabledAt.Valid || hasMembership
	}
	plan, err := feishuorg.BuildPlan(snapshot, mappings, members, memberships)
	if err != nil {
		return feishuorg.Plan{}, err
	}
	// Team grants live on the agent (agent_invocation_target) and are made
	// from the access picker. The sync only revokes grants whose group was
	// removed from the rules, so a deleted department does not linger as a
	// dead allow-list entry.
	targetRows, err := q.ListFeishuOrgAgentTargets(ctx, workspaceID)
	if err != nil {
		return feishuorg.Plan{}, err
	}
	groupByID := make(map[string]db.FeishuOrgGroup, len(groups))
	for _, group := range groups {
		groupByID[uuidToString(group.ID)] = group
	}
	plan.AgentChanges = []feishuorg.AgentChange{}
	for _, row := range targetRows {
		group := groupByID[uuidToString(row.GroupID)]
		if group.Configured {
			continue
		}
		plan.AgentChanges = append(plan.AgentChanges, feishuorg.AgentChange{
			AgentID: uuidToString(row.AgentID), GroupID: uuidToString(row.GroupID), GroupName: group.ExternalName, Action: "agent_revoked",
		})
	}
	sort.Slice(plan.AgentChanges, func(i, j int) bool {
		if plan.AgentChanges[i].AgentID != plan.AgentChanges[j].AgentID {
			return plan.AgentChanges[i].AgentID < plan.AgentChanges[j].AgentID
		}
		return plan.AgentChanges[i].GroupID < plan.AgentChanges[j].GroupID
	})
	return plan, nil
}

func (h *Handler) createFeishuOrgSyncRun(
	ctx context.Context,
	q *db.Queries,
	actor feishuOrgActor,
	mode, status string,
	revision int64,
	plan feishuorg.Plan,
	errorMessage string,
	replayedFromID pgtype.UUID,
) (db.FeishuOrgSyncRun, error) {
	if plan.Changes == nil {
		plan.Changes = []feishuorg.Change{}
	}
	if plan.AgentChanges == nil {
		plan.AgentChanges = []feishuorg.AgentChange{}
	}
	if plan.Warnings == nil {
		plan.Warnings = []string{}
	}
	planJSON, err := json.Marshal(plan)
	if err != nil {
		return db.FeishuOrgSyncRun{}, err
	}
	run, err := q.CreateFeishuOrgSyncRun(ctx, db.CreateFeishuOrgSyncRunParams{
		WorkspaceID: actor.workspaceID, Mode: mode, Status: status, Revision: revision,
		Plan: planJSON, RequestedBy: actor.userID, ReplayedFromID: replayedFromID,
	})
	if err != nil || status == "preview" {
		return run, err
	}
	return q.UpdateFeishuOrgSyncRun(ctx, db.UpdateFeishuOrgSyncRunParams{
		Status: status, Plan: planJSON,
		Error:       pgtype.Text{String: errorMessage, Valid: errorMessage != ""},
		CompletedAt: pgtype.Timestamptz{Time: time.Now(), Valid: true},
		ID:          run.ID, WorkspaceID: actor.workspaceID,
	})
}
