package handler

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/logger"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// validNotifGroups is the set of notification preference group keys that the
// API accepts. Keys not in this set are rejected. `system_notifications` is
// not an inbox event group — it's a delivery-channel toggle controlling
// whether native OS notification banners fire — but it shares the same
// preferences map so a single endpoint covers all user notification
// preferences. `feishu_notifications` is likewise a channel toggle, for
// Feishu direct messages, and is off unless set to "all".
var validNotifGroups = map[string]bool{
	"assignments":          true,
	"status_changes":       true,
	"comments":             true,
	"mentions":             true,
	"updates":              true,
	"agent_activity":       true,
	"system_notifications": true,
	"feishu_notifications": true,
}

// Reasons Feishu notifications are unavailable to the caller.
const (
	feishuNotifUnavailableNotConfigured = "not_configured"
	feishuNotifUnavailableNotLinked     = "not_linked"
)

// feishuNotificationStatus tells the settings UI whether the caller can
// receive Feishu direct messages. Reason is empty when Available is true.
type feishuNotificationStatus struct {
	Available bool   `json:"available"`
	Reason    string `json:"reason"`
}

func (h *Handler) feishuNotificationStatus(r *http.Request, userID string) feishuNotificationStatus {
	if _, ok := feishuLoginApp(); !ok {
		return feishuNotificationStatus{Reason: feishuNotifUnavailableNotConfigured}
	}
	user, err := h.Queries.GetUser(r.Context(), parseUUID(userID))
	if err != nil {
		slog.Warn("GetUser for feishu notification status failed", append(logger.RequestAttrs(r), "error", err)...)
		return feishuNotificationStatus{Reason: feishuNotifUnavailableNotLinked}
	}
	if (user.FeishuOpenID.Valid && user.FeishuOpenID.String != "") || (user.FeishuUnionID.Valid && user.FeishuUnionID.String != "") {
		return feishuNotificationStatus{Available: true}
	}
	return feishuNotificationStatus{Reason: feishuNotifUnavailableNotLinked}
}

// validNotifValues is the set of allowed preference values per group.
var validNotifValues = map[string]bool{
	"all":   true,
	"muted": true,
}

func (h *Handler) GetNotificationPreferences(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	workspaceID := ctxWorkspaceID(r.Context())

	pref, err := h.Queries.GetNotificationPreference(r.Context(), db.GetNotificationPreferenceParams{
		WorkspaceID: parseUUID(workspaceID),
		UserID:      parseUUID(userID),
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeJSON(w, http.StatusOK, map[string]any{
				"workspace_id": workspaceID,
				"preferences":  map[string]any{},
				"feishu":       h.feishuNotificationStatus(r, userID),
			})
			return
		}
		slog.Warn("GetNotificationPreference failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to get notification preferences")
		return
	}

	var prefs map[string]string
	if err := json.Unmarshal(pref.Preferences, &prefs); err != nil {
		prefs = map[string]string{}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"workspace_id": workspaceID,
		"preferences":  prefs,
		"feishu":       h.feishuNotificationStatus(r, userID),
	})
}

type updateNotifPrefRequest struct {
	Preferences map[string]string `json:"preferences"`
}

func decodeNotificationPreferenceRequest(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	var req updateNotifPrefRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return nil, false
	}

	if req.Preferences == nil {
		writeError(w, http.StatusBadRequest, "preferences field is required")
		return nil, false
	}

	for k, v := range req.Preferences {
		if !validNotifGroups[k] {
			writeError(w, http.StatusBadRequest, "invalid preference group: "+k)
			return nil, false
		}
		if !validNotifValues[v] {
			writeError(w, http.StatusBadRequest, "invalid preference value: "+v)
			return nil, false
		}
	}

	prefsJSON, err := json.Marshal(req.Preferences)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to marshal preferences")
		return nil, false
	}
	return prefsJSON, true
}

func writeNotificationPreferenceResponse(
	w http.ResponseWriter,
	workspaceID string,
	pref db.NotificationPreference,
) {
	var prefs map[string]string
	if err := json.Unmarshal(pref.Preferences, &prefs); err != nil {
		prefs = map[string]string{}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"workspace_id": workspaceID,
		"preferences":  prefs,
	})
}

// UpdateNotificationPreferences preserves the original replace-all PUT
// contract for compatibility with installed clients.
func (h *Handler) UpdateNotificationPreferences(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	workspaceID := ctxWorkspaceID(r.Context())
	prefsJSON, ok := decodeNotificationPreferenceRequest(w, r)
	if !ok {
		return
	}

	pref, err := h.Queries.UpsertNotificationPreference(r.Context(), db.UpsertNotificationPreferenceParams{
		WorkspaceID: parseUUID(workspaceID),
		UserID:      parseUUID(userID),
		Preferences: prefsJSON,
	})
	if err != nil {
		slog.Warn("UpsertNotificationPreference failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to update notification preferences")
		return
	}
	writeNotificationPreferenceResponse(w, workspaceID, pref)
}

// PatchNotificationPreferences atomically merges only the supplied keys. This
// prevents stale tabs or devices from replacing unrelated mute settings.
func (h *Handler) PatchNotificationPreferences(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	workspaceID := ctxWorkspaceID(r.Context())
	prefsJSON, ok := decodeNotificationPreferenceRequest(w, r)
	if !ok {
		return
	}

	pref, err := h.Queries.PatchNotificationPreference(r.Context(), db.PatchNotificationPreferenceParams{
		WorkspaceID: parseUUID(workspaceID),
		UserID:      parseUUID(userID),
		Preferences: prefsJSON,
	})
	if err != nil {
		slog.Warn("PatchNotificationPreference failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to update notification preferences")
		return
	}
	writeNotificationPreferenceResponse(w, workspaceID, pref)
}
