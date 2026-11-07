package handler

// Fork extension points for workspace plugins (see FORK.md):
//
//   - workspace_page surfaces, and the bridge endpoints a page needs: list
//     issues, batch comment, batch status change;
//   - plugin-declared buttons on Feishu notification cards
//     (plugin_card_action_fork.go).
//
// Both are off unless the workspace sets them in
// workspace.settings.plugin_extensions. Off, every path here refuses or
// renders nothing, so the product behaves exactly as upstream.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
	"github.com/multica-ai/multica/server/pkg/plugincontract"
	"github.com/multica-ai/multica/server/pkg/protocol"
	publicapiv1 "github.com/multica-ai/multica/server/pkg/publicapi/v1"
)

// PluginExtensionsSettingsKey is the workspace.settings key holding the
// switches. Only an explicit true turns a switch on.
const PluginExtensionsSettingsKey = "plugin_extensions"

// PluginExtensions are the per-workspace switches.
type PluginExtensions struct {
	WorkspacePages bool `json:"workspace_pages"`
	CardButtons    bool `json:"card_buttons"`
}

// ParsePluginExtensions reads the switches from workspace settings JSON.
func ParsePluginExtensions(settings []byte) PluginExtensions {
	var root map[string]json.RawMessage
	if len(settings) == 0 || json.Unmarshal(settings, &root) != nil {
		return PluginExtensions{}
	}
	var raw map[string]any
	if json.Unmarshal(root[PluginExtensionsSettingsKey], &raw) != nil {
		return PluginExtensions{}
	}
	return PluginExtensions{
		WorkspacePages: raw["workspace_pages"] == true,
		CardButtons:    raw["card_buttons"] == true,
	}
}

func (h *Handler) workspacePluginExtensions(ctx context.Context, workspaceID pgtype.UUID) PluginExtensions {
	workspace, err := h.Queries.GetWorkspace(ctx, workspaceID)
	if err != nil {
		return PluginExtensions{}
	}
	return ParsePluginExtensions(workspace.Settings)
}

// pluginSurfaceLaunchAllowed refuses to launch a workspace_page surface while
// the workspace has pages switched off. Other surface types are unaffected.
func (h *Handler) pluginSurfaceLaunchAllowed(w http.ResponseWriter, r *http.Request, workspaceID pgtype.UUID, installation db.PluginInstallation, surfaceKey string) bool {
	manifest, err := service.ParseInstallationManifest(installation)
	if err != nil {
		return true // SurfaceScript reports the unreadable manifest.
	}
	for _, surface := range manifest.Contributes.Surfaces {
		if surface.Key == surfaceKey && surface.Type == plugincontract.SurfaceWorkspacePage {
			if !h.workspacePluginExtensions(r.Context(), workspaceID).WorkspacePages {
				writeErrorCode(w, http.StatusForbidden, "plugin_extension_disabled", "Plugin workspace pages are turned off for this workspace")
				return false
			}
		}
	}
	return true
}

// registerPluginForkBridgeRoutes adds the workspace-page endpoints to the
// browser-session bridge. They are not part of the Public API v1 ledger: a
// page acts as the signed-in user, and only the bridge carries one.
func RegisterPluginForkBridgeRoutes(r chi.Router, h *Handler) {
	r.Get("/issues", h.ListPluginPageIssues)
	r.Post("/issue-batches/comments", h.BatchCommentPluginPageIssues)
	r.Post("/issue-batches/status", h.BatchSetStatusPluginPageIssues)
}

// pluginPageCaller authorizes a workspace-page call: the plugin holds the
// scope, the workspace has pages on, and a member is behind the call.
func (h *Handler) pluginPageCaller(w http.ResponseWriter, r *http.Request, scope string) (service.PluginActionCaller, pluginActor, bool) {
	caller, actor, ok := h.pluginCaller(w, r, scope)
	if !ok {
		return caller, actor, false
	}
	if !actor.requireMember(w, r) {
		return caller, actor, false
	}
	if !h.workspacePluginExtensions(r.Context(), caller.WorkspaceID).WorkspacePages {
		publicapiv1.WriteProblem(w, r, http.StatusForbidden, "plugin_extension_disabled", "Plugin workspace pages are turned off for this workspace")
		return caller, actor, false
	}
	return caller, actor, true
}

const (
	pluginPageDefaultLimit = 50
	pluginPageMaxLimit     = 200
	pluginPageMaxBatch     = 100
)

type pluginPageIssue struct {
	ID             string  `json:"id"`
	Identifier     string  `json:"identifier"`
	Title          string  `json:"title"`
	Status         string  `json:"status"`
	StatusCategory string  `json:"status_category,omitempty"`
	StatusName     string  `json:"status_name"`
	Priority       string  `json:"priority"`
	AssigneeType   *string `json:"assignee_type"`
	AssigneeID     *string `json:"assignee_id"`
	ProjectID      *string `json:"project_id"`
	CreatedAt      string  `json:"created_at"`
	UpdatedAt      string  `json:"updated_at"`
}

type pluginPageIssueList struct {
	Issues []pluginPageIssue `json:"issues"`
	// NextOffset is the offset of the next page, or null on the last page.
	NextOffset *int `json:"next_offset"`
}

// ListPluginPageIssues — GET /issues?project_id=&status=&assignee_id=&limit=&offset=
func (h *Handler) ListPluginPageIssues(w http.ResponseWriter, r *http.Request) {
	caller, _, ok := h.pluginPageCaller(w, r, plugincontract.ScopeIssuesRead)
	if !ok {
		return
	}
	query := r.URL.Query()
	limit := pluginPageDefaultLimit
	if raw := query.Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > pluginPageMaxLimit {
			publicapiv1.WriteProblem(w, r, http.StatusBadRequest, "invalid_request", fmt.Sprintf("limit must be between 1 and %d", pluginPageMaxLimit))
			return
		}
		limit = parsed
	}
	offset := 0
	if raw := query.Get("offset"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 0 || parsed > 100000 {
			publicapiv1.WriteProblem(w, r, http.StatusBadRequest, "invalid_request", "offset must be a non-negative integer")
			return
		}
		offset = parsed
	}
	params := db.ListIssuesParams{
		WorkspaceID: caller.WorkspaceID,
		// One extra row says whether another page exists.
		Limit:  int32(limit + 1),
		Offset: int32(offset),
	}
	for name, target := range map[string]*pgtype.UUID{"project_id": &params.ProjectID, "assignee_id": &params.AssigneeID} {
		raw := query.Get(name)
		if raw == "" {
			continue
		}
		parsed, err := util.ParseUUID(raw)
		if err != nil {
			publicapiv1.WriteProblem(w, r, http.StatusBadRequest, "invalid_request", name+" must be a valid UUID")
			return
		}
		*target = parsed
	}
	if status := strings.TrimSpace(query.Get("status")); status != "" {
		params.Status = pgtype.Text{String: status, Valid: true}
	}

	rows, err := h.Queries.ListIssues(r.Context(), params)
	if err != nil {
		publicapiv1.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "failed to list issues")
		return
	}
	prefix := ""
	if workspace, err := h.Queries.GetWorkspace(r.Context(), caller.WorkspaceID); err == nil {
		prefix = workspace.IssuePrefix
	}
	out := pluginPageIssueList{Issues: make([]pluginPageIssue, 0, len(rows))}
	if len(rows) > limit {
		rows = rows[:limit]
		next := offset + limit
		out.NextOffset = &next
	}
	fill := h.newStatusCategoryFiller(r.Context(), caller.WorkspaceID)
	for _, row := range rows {
		issue := issueListRowToResponse(row, prefix)
		fill(&issue)
		out.Issues = append(out.Issues, pluginPageIssue{
			ID:             issue.ID,
			Identifier:     issue.Identifier,
			Title:          issue.Title,
			Status:         issue.Status,
			StatusCategory: issue.StatusCategory,
			StatusName:     issue.StatusName,
			Priority:       issue.Priority,
			AssigneeType:   issue.AssigneeType,
			AssigneeID:     issue.AssigneeID,
			ProjectID:      issue.ProjectID,
			CreatedAt:      issue.CreatedAt,
			UpdatedAt:      issue.UpdatedAt,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

type pluginBatchRequest struct {
	IssueIDs []string `json:"issue_ids"`
	Content  string   `json:"content"`
	Status   string   `json:"status"`
}

// Per-item outcomes of a batch operation.
const (
	pluginItemOK        = "ok"
	pluginItemForbidden = "forbidden"
	pluginItemNotFound  = "not_found"
	pluginItemInvalid   = "invalid"
	pluginItemFailed    = "failed"
)

type pluginBatchItemResult struct {
	IssueID string `json:"issue_id"`
	Status  string `json:"status"`
	Error   string `json:"error,omitempty"`
}

type pluginBatchResponse struct {
	Results   []pluginBatchItemResult `json:"results"`
	Succeeded int                     `json:"succeeded"`
	Failed    int                     `json:"failed"`
}

func decodePluginBatch(w http.ResponseWriter, r *http.Request) (pluginBatchRequest, bool) {
	var req pluginBatchRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		publicapiv1.WriteProblem(w, r, http.StatusBadRequest, "invalid_request", "invalid request body")
		return req, false
	}
	if len(req.IssueIDs) == 0 || len(req.IssueIDs) > pluginPageMaxBatch {
		publicapiv1.WriteProblem(w, r, http.StatusBadRequest, "invalid_request", fmt.Sprintf("issue_ids must have between 1 and %d entries", pluginPageMaxBatch))
		return req, false
	}
	return req, true
}

// BatchCommentPluginPageIssues — POST /issue-batches/comments
func (h *Handler) BatchCommentPluginPageIssues(w http.ResponseWriter, r *http.Request) {
	caller, actor, ok := h.pluginPageCaller(w, r, plugincontract.ScopeCommentsWrite)
	if !ok {
		return
	}
	req, ok := decodePluginBatch(w, r)
	if !ok {
		return
	}
	content := sanitizeNullBytes(req.Content)
	if strings.TrimSpace(content) == "" || len(content) > maxCommentContentBytes {
		publicapiv1.WriteProblem(w, r, http.StatusBadRequest, "invalid_request", "content is required and must fit a comment")
		return
	}
	h.runPluginBatch(w, r, caller, actor.Member.UserID, req.IssueIDs, func(issue db.Issue) (string, string) {
		return h.pluginCommentAsMember(r.Context(), caller, actor.Member.UserID, issue, content)
	}, "comment")
}

// BatchSetStatusPluginPageIssues — POST /issue-batches/status
func (h *Handler) BatchSetStatusPluginPageIssues(w http.ResponseWriter, r *http.Request) {
	caller, actor, ok := h.pluginPageCaller(w, r, plugincontract.ScopeIssuesWrite)
	if !ok {
		return
	}
	req, ok := decodePluginBatch(w, r)
	if !ok {
		return
	}
	status := strings.TrimSpace(req.Status)
	if status == "" {
		publicapiv1.WriteProblem(w, r, http.StatusBadRequest, "invalid_request", "status is required")
		return
	}
	h.runPluginBatch(w, r, caller, actor.Member.UserID, req.IssueIDs, func(issue db.Issue) (string, string) {
		return h.pluginSetStatusAsMember(r.Context(), caller, actor.Member.UserID, issue, status)
	}, "set_status")
}

func (h *Handler) runPluginBatch(w http.ResponseWriter, r *http.Request, caller service.PluginActionCaller, userID pgtype.UUID, refs []string, apply func(db.Issue) (string, string), action string) {
	out := pluginBatchResponse{Results: make([]pluginBatchItemResult, 0, len(refs))}
	for _, ref := range refs {
		result := pluginBatchItemResult{IssueID: ref}
		issue, status, message := h.pluginItemIssue(r, caller, userID, ref)
		if status == pluginItemOK {
			status, message = apply(issue)
		} else {
			// apply records its own audit row; a refusal before it does not.
			h.recordPluginBatchAction(r.Context(), caller, userID, ref, issue.ID, action, status, message)
		}
		result.Status, result.Error = status, message
		if status == pluginItemOK {
			out.Succeeded++
		} else {
			out.Failed++
		}
		out.Results = append(out.Results, result)
	}
	writeJSON(w, http.StatusOK, out)
}

// pluginItemIssue is the per-item permission check: the user is still a
// member of the installation's workspace, and the issue is in it (and inside
// the caller's issue scope, if any). A missing issue and one outside the
// workspace are the same not_found.
func (h *Handler) pluginItemIssue(r *http.Request, caller service.PluginActionCaller, userID pgtype.UUID, ref string) (db.Issue, string, string) {
	if strings.TrimSpace(ref) == "" || len(ref) > 128 {
		return db.Issue{}, pluginItemInvalid, "invalid issue id"
	}
	if _, err := h.getWorkspaceMember(r.Context(), uuidToString(userID), uuidToString(caller.WorkspaceID)); err != nil {
		return db.Issue{}, pluginItemForbidden, "not a member of this workspace"
	}
	issue, ok := h.resolvePluginIssue(r, caller, ref)
	if !ok || (caller.IssueScope.Valid && uuidToString(issue.ID) != uuidToString(caller.IssueScope)) {
		return db.Issue{}, pluginItemNotFound, "issue not found"
	}
	return issue, pluginItemOK, ""
}

func (h *Handler) recordPluginBatchAction(ctx context.Context, caller service.PluginActionCaller, userID pgtype.UUID, ref string, issueID pgtype.UUID, action, status, message string) {
	params := db.CreatePluginBatchActionParams{
		WorkspaceID: caller.WorkspaceID,
		ViaPluginID: caller.Installation.ID,
		UserID:      userID,
		IssueRef:    truncatePluginText(ref, 128),
		IssueID:     issueID,
		Action:      action,
		Status:      status,
	}
	if message != "" {
		params.Error = pgtype.Text{String: truncatePluginText(message, 500), Valid: true}
	}
	// Best effort: the audit row must not fail the write it describes.
	_ = h.Queries.CreatePluginBatchAction(ctx, params)
}

// pluginCommentAsMember posts a comment authored by the user and marked with
// the plugin (via_plugin_id). Like CreatePluginComment it does not run
// @mention dispatch.
func (h *Handler) pluginCommentAsMember(ctx context.Context, caller service.PluginActionCaller, userID pgtype.UUID, issue db.Issue, content string) (string, string) {
	status, message := pluginItemOK, ""
	defer func() {
		h.recordPluginBatchAction(ctx, caller, userID, uuidToString(issue.ID), issue.ID, "comment", status, message)
	}()
	if !hasGrantedScope(caller.Scopes, plugincontract.ScopeCommentsWrite) {
		status, message = pluginItemForbidden, "this Plugin was not granted the comments:write scope"
		return status, message
	}
	created, err := h.Queries.CreateComment(ctx, db.CreateCommentParams{
		ID:          dbid.NewV7(),
		IssueID:     issue.ID,
		WorkspaceID: caller.WorkspaceID,
		AuthorType:  "member",
		AuthorID:    userID,
		Content:     content,
		Type:        "comment",
		ViaPluginID: caller.Installation.ID,
	})
	if err != nil {
		status, message = pluginItemFailed, "failed to create the comment"
		return status, message
	}
	comment := created.Comment()
	h.publish(protocol.EventCommentCreated, uuidToString(caller.WorkspaceID), "member", uuidToString(userID), map[string]any{
		"comment":             commentToResponse(comment, nil, nil),
		"issue_title":         issue.Title,
		"issue_assignee_type": textToPtr(issue.AssigneeType),
		"issue_assignee_id":   uuidToPtr(issue.AssigneeID),
		"issue_status":        issue.Status,
	})
	return status, message
}

// pluginSetStatusAsMember changes status through the ordinary issue update
// handler, as the user. Status changes carry dispatch and catalog semantics
// (custom statuses, agent runs, parent rules); going through the one handler
// that owns them means a plugin gets exactly the user's behavior.
func (h *Handler) pluginSetStatusAsMember(ctx context.Context, caller service.PluginActionCaller, userID pgtype.UUID, issue db.Issue, status string) (string, string) {
	outcome, message := pluginItemOK, ""
	defer func() {
		h.recordPluginBatchAction(ctx, caller, userID, uuidToString(issue.ID), issue.ID, "set_status", outcome, message)
	}()
	if !hasGrantedScope(caller.Scopes, plugincontract.ScopeIssuesWrite) {
		outcome, message = pluginItemForbidden, "this Plugin was not granted the issues:write scope"
		return outcome, message
	}
	body, _ := json.Marshal(map[string]string{"status": status})
	issueID := uuidToString(issue.ID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, "/api/issues/"+issueID, bytes.NewReader(body))
	if err != nil {
		outcome, message = pluginItemFailed, "failed to build the update"
		return outcome, message
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-User-ID", uuidToString(userID))
	req.Header.Set("X-Workspace-ID", uuidToString(caller.WorkspaceID))
	route := chi.NewRouteContext()
	route.URLParams.Add("id", issueID)
	req = req.WithContext(context.WithValue(ctx, chi.RouteCtxKey, route))

	recorder := &pluginInternalResponse{header: http.Header{}}
	h.UpdateIssue(recorder, req)
	switch {
	case recorder.status >= 200 && recorder.status < 300:
		return outcome, message
	case recorder.status == http.StatusNotFound:
		outcome = pluginItemNotFound
	case recorder.status == http.StatusForbidden:
		outcome = pluginItemForbidden
	case recorder.status >= 400 && recorder.status < 500:
		outcome = pluginItemInvalid
	default:
		outcome = pluginItemFailed
	}
	message = recorder.errorMessage()
	return outcome, message
}

// pluginInternalResponse captures an in-process handler response.
type pluginInternalResponse struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func (p *pluginInternalResponse) Header() http.Header { return p.header }

func (p *pluginInternalResponse) WriteHeader(status int) {
	if p.status == 0 {
		p.status = status
	}
}

func (p *pluginInternalResponse) Write(b []byte) (int, error) {
	if p.status == 0 {
		p.status = http.StatusOK
	}
	if p.body.Len() < 4096 {
		p.body.Write(b)
	}
	return len(b), nil
}

func (p *pluginInternalResponse) errorMessage() string {
	var payload struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(p.body.Bytes(), &payload) == nil && payload.Error != "" {
		return truncatePluginText(payload.Error, 500)
	}
	return fmt.Sprintf("update failed with status %d", p.status)
}

// truncatePluginText cuts to at most limit bytes on a rune boundary, so the
// result stays valid UTF-8 for the database.
func truncatePluginText(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	cut := limit
	for cut > 0 && !utf8.RuneStart(value[cut]) {
		cut--
	}
	return value[:cut]
}
