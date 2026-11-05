package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

// LarkOrganizationGroupResponse is an active organization group as seen by any
// workspace member: enough to name it as an agent team target, without the
// role or membership details the admin console shows.
type LarkOrganizationGroupResponse struct {
	ID           string `json:"id"`
	Kind         string `json:"kind"`
	ExternalID   string `json:"external_id"`
	ExternalName string `json:"external_name"`
}

type ListLarkOrganizationGroupsResponse struct {
	Groups []LarkOrganizationGroupResponse `json:"groups"`
}

// ListLarkOrganizationGroups returns the organization groups that currently
// grant access, so an agent owner can pick them in the access picker. The
// router gates it on workspace membership.
func (h *Handler) ListLarkOrganizationGroups(w http.ResponseWriter, r *http.Request) {
	workspaceID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "workspace id")
	if !ok {
		return
	}
	if _, ok := h.workspaceMember(w, r, uuidToString(workspaceID)); !ok {
		return
	}
	groups, err := h.Queries.ListActiveFeishuOrgGroups(r.Context(), workspaceID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list organization groups")
		return
	}
	response := ListLarkOrganizationGroupsResponse{Groups: make([]LarkOrganizationGroupResponse, 0, len(groups))}
	for _, group := range groups {
		response.Groups = append(response.Groups, LarkOrganizationGroupResponse{
			ID: uuidToString(group.ID), Kind: group.Kind, ExternalID: group.ExternalID, ExternalName: group.ExternalName,
		})
	}
	writeJSON(w, http.StatusOK, response)
}
