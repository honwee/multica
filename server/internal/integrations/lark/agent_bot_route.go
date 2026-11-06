package lark

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// AgentBotRoute is how one member is reached through one agent's bot.
type AgentBotRoute struct {
	InstallationID pgtype.UUID
	Credentials    InstallationCredentials
	ReceiveIDType  string
	ReceiveID      string
}

var (
	// ErrNoAgentBot means the agent has no active Feishu bot in the workspace.
	ErrNoAgentBot = errors.New("no bot for agent")
	// ErrAgentBotRecipientUnreachable means the bot exists but the member has
	// no identity it can address.
	ErrAgentBotRecipientUnreachable = errors.New("recipient unreachable via bot")
)

type agentBotStore interface {
	ListLarkInstallationsByWorkspace(ctx context.Context, workspaceID pgtype.UUID) ([]Installation, error)
	FindChannelBindingForMemberOnAgentInstallation(ctx context.Context, arg db.FindChannelBindingForMemberOnAgentInstallationParams) (db.ChannelUserBinding, error)
}

type appSecretDecrypter interface {
	DecryptAppSecret(inst Installation) (string, error)
}

// AgentBotRouter resolves the bot an agent owns and the identity a member is
// addressed by under that bot's app.
type AgentBotRouter struct {
	store   agentBotStore
	secrets appSecretDecrypter
}

// NewAgentBotRouter builds a router over the channel store.
func NewAgentBotRouter(store *ChannelStore, installs *InstallationService) *AgentBotRouter {
	return &AgentBotRouter{store: store, secrets: installs}
}

// Route picks the agent's active bot in the workspace and the member's
// identity under it. open_id values are issued per app, so the login app's
// open_id is never used here. The member's binding on this bot (recorded when
// they first messaged it) comes first: its open_id lands the message in their
// existing direct chat with the bot. union_id, shared by every app of the
// same developer, is the second choice.
func (r *AgentBotRouter) Route(ctx context.Context, workspaceID, agentID pgtype.UUID, user db.User) (AgentBotRoute, error) {
	installs, err := r.store.ListLarkInstallationsByWorkspace(ctx, workspaceID)
	if err != nil {
		return AgentBotRoute{}, fmt.Errorf("list installations: %w", err)
	}
	var inst *Installation
	for i := range installs {
		if installs[i].AgentID == agentID && InstallationStatus(installs[i].Status) == InstallationActive {
			inst = &installs[i]
			break
		}
	}
	if inst == nil {
		return AgentBotRoute{}, ErrNoAgentBot
	}

	route := AgentBotRoute{InstallationID: inst.ID}
	binding, err := r.store.FindChannelBindingForMemberOnAgentInstallation(ctx, db.FindChannelBindingForMemberOnAgentInstallationParams{
		WorkspaceID:   workspaceID,
		MulticaUserID: user.ID,
		ChannelType:   channelTypeFeishu,
		AgentID:       agentID,
	})
	switch {
	case err == nil && binding.InstallationID == inst.ID && binding.ChannelUserID != "":
		route.ReceiveIDType, route.ReceiveID = ReceiveIDTypeOpenID, binding.ChannelUserID
	case err != nil && !errors.Is(err, pgx.ErrNoRows):
		return AgentBotRoute{}, fmt.Errorf("find member binding: %w", err)
	case user.FeishuUnionID.Valid && user.FeishuUnionID.String != "":
		route.ReceiveIDType, route.ReceiveID = ReceiveIDTypeUnionID, user.FeishuUnionID.String
	default:
		return AgentBotRoute{}, ErrAgentBotRecipientUnreachable
	}

	secret, err := r.secrets.DecryptAppSecret(*inst)
	if err != nil {
		return AgentBotRoute{}, err
	}
	route.Credentials = InstallationCredentials{
		AppID:     inst.AppID,
		AppSecret: secret,
		TenantKey: inst.TenantKey.String,
		Region:    RegionOrDefault(inst.Region),
	}
	return route, nil
}
