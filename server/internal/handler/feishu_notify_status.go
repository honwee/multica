package handler

import (
	"log/slog"
	"net/http"

	"github.com/multica-ai/multica/server/internal/integrations/lark"
	"github.com/multica-ai/multica/server/internal/logger"
)

// Reasons Feishu notifications are unavailable to the caller.
const (
	// feishuNotifUnavailableNotLinked: the account has no Feishu identity.
	feishuNotifUnavailableNotLinked = "not_linked"
	// feishuNotifUnavailableNoAgentBot: no agent in the workspace has an
	// active Feishu bot, and only agent bots send notifications.
	feishuNotifUnavailableNoAgentBot = "no_agent_bot"
)

// feishuNotificationStatus tells the settings UI whether the caller can
// receive Feishu direct messages. Reason is empty when Available is true.
type feishuNotificationStatus struct {
	Available bool   `json:"available"`
	Reason    string `json:"reason"`
}

// feishuNotificationStatus reports the caller available when they have a
// Feishu identity and at least one agent in the workspace has an active
// Feishu bot. The Feishu login app does not count: it never sends
// notifications.
func (h *Handler) feishuNotificationStatus(r *http.Request, userID, workspaceID string) feishuNotificationStatus {
	user, err := h.Queries.GetUser(r.Context(), parseUUID(userID))
	if err != nil {
		slog.Warn("GetUser for feishu notification status failed", append(logger.RequestAttrs(r), "error", err)...)
		return feishuNotificationStatus{Reason: feishuNotifUnavailableNotLinked}
	}
	linked := (user.FeishuOpenID.Valid && user.FeishuOpenID.String != "") ||
		(user.FeishuUnionID.Valid && user.FeishuUnionID.String != "")
	if !linked {
		return feishuNotificationStatus{Reason: feishuNotifUnavailableNotLinked}
	}
	if !h.workspaceHasAgentFeishuBot(r, workspaceID) {
		return feishuNotificationStatus{Reason: feishuNotifUnavailableNoAgentBot}
	}
	return feishuNotificationStatus{Available: true}
}

func (h *Handler) workspaceHasAgentFeishuBot(r *http.Request, workspaceID string) bool {
	if h.LarkInstallations == nil {
		return false
	}
	installs, err := h.LarkInstallations.ListByWorkspace(r.Context(), parseUUID(workspaceID))
	if err != nil {
		slog.Warn("list lark installations for feishu notification status failed", append(logger.RequestAttrs(r), "error", err)...)
		return false
	}
	for _, inst := range installs {
		if inst.AgentID.Valid && lark.InstallationStatus(inst.Status) == lark.InstallationActive {
			return true
		}
	}
	return false
}
