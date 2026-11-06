package lark

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type fakeAgentBotStore struct {
	installs []Installation
	binding  *db.ChannelUserBinding
	gotFind  db.FindChannelBindingForMemberOnAgentInstallationParams
}

func (f *fakeAgentBotStore) ListLarkInstallationsByWorkspace(context.Context, pgtype.UUID) ([]Installation, error) {
	return f.installs, nil
}

func (f *fakeAgentBotStore) FindChannelBindingForMemberOnAgentInstallation(_ context.Context, arg db.FindChannelBindingForMemberOnAgentInstallationParams) (db.ChannelUserBinding, error) {
	f.gotFind = arg
	if f.binding == nil {
		return db.ChannelUserBinding{}, pgx.ErrNoRows
	}
	return *f.binding, nil
}

type fakeSecrets struct{}

func (fakeSecrets) DecryptAppSecret(inst Installation) (string, error) {
	return "secret-of-" + inst.AppID, nil
}

func routeUUID(b byte) pgtype.UUID {
	var u pgtype.UUID
	u.Bytes[15] = b
	u.Valid = true
	return u
}

func agentBotFixture() (*fakeAgentBotStore, pgtype.UUID, pgtype.UUID, db.User) {
	ws, agent := routeUUID(1), routeUUID(2)
	store := &fakeAgentBotStore{installs: []Installation{
		{ID: routeUUID(10), WorkspaceID: ws, AgentID: routeUUID(3), AppID: "cli_other", Status: string(InstallationActive)},
		{ID: routeUUID(11), WorkspaceID: ws, AgentID: agent, AppID: "cli_revoked", Status: string(InstallationRevoked)},
		{ID: routeUUID(12), WorkspaceID: ws, AgentID: agent, AppID: "cli_agent", Status: string(InstallationActive),
			TenantKey: pgtype.Text{String: "tk", Valid: true}},
	}}
	user := db.User{
		ID:            routeUUID(4),
		FeishuOpenID:  pgtype.Text{String: "ou_login_app", Valid: true},
		FeishuUnionID: pgtype.Text{String: "on_user", Valid: true},
	}
	return store, ws, agent, user
}

func TestAgentBotRouter_PrefersOpenIDFromDirectChat(t *testing.T) {
	store, ws, agent, user := agentBotFixture()
	store.binding = &db.ChannelUserBinding{InstallationID: routeUUID(12), ChannelUserID: "ou_under_bot"}
	r := &AgentBotRouter{store: store, secrets: fakeSecrets{}}
	route, err := r.Route(context.Background(), ws, agent, user)
	if err != nil {
		t.Fatal(err)
	}
	if route.ReceiveIDType != ReceiveIDTypeOpenID || route.ReceiveID != "ou_under_bot" {
		t.Fatalf("addressed %s=%s, want the open_id under the bot", route.ReceiveIDType, route.ReceiveID)
	}
	if route.Credentials.AppID != "cli_agent" || route.Credentials.AppSecret != "secret-of-cli_agent" || route.Credentials.TenantKey != "tk" {
		t.Fatalf("credentials = %+v", route.Credentials)
	}
	if store.gotFind.AgentID != agent || store.gotFind.MulticaUserID != user.ID || store.gotFind.ChannelType != "feishu" {
		t.Fatalf("binding lookup params = %+v", store.gotFind)
	}
}

func TestAgentBotRouter_UsesUnionIDWithoutDirectChat(t *testing.T) {
	store, ws, agent, user := agentBotFixture()
	r := &AgentBotRouter{store: store, secrets: fakeSecrets{}}
	route, err := r.Route(context.Background(), ws, agent, user)
	if err != nil {
		t.Fatal(err)
	}
	if route.ReceiveIDType != ReceiveIDTypeUnionID || route.ReceiveID != "on_user" {
		t.Fatalf("addressed %s=%s, want union_id (never the login app's open_id)", route.ReceiveIDType, route.ReceiveID)
	}
}

func TestAgentBotRouter_Unreachable(t *testing.T) {
	store, ws, agent, user := agentBotFixture()
	user.FeishuUnionID = pgtype.Text{}
	r := &AgentBotRouter{store: store, secrets: fakeSecrets{}}
	if _, err := r.Route(context.Background(), ws, agent, user); !errors.Is(err, ErrAgentBotRecipientUnreachable) {
		t.Fatalf("err = %v, want ErrAgentBotRecipientUnreachable", err)
	}
}

func TestAgentBotRouter_NoActiveBot(t *testing.T) {
	store, ws, _, user := agentBotFixture()
	r := &AgentBotRouter{store: store, secrets: fakeSecrets{}}
	if _, err := r.Route(context.Background(), ws, routeUUID(9), user); !errors.Is(err, ErrNoAgentBot) {
		t.Fatalf("err = %v, want ErrNoAgentBot", err)
	}
	store.installs = store.installs[:2] // only the agent's revoked install remains
	if _, err := r.Route(context.Background(), ws, routeUUID(2), user); !errors.Is(err, ErrNoAgentBot) {
		t.Fatalf("revoked install: err = %v, want ErrNoAgentBot", err)
	}
}
