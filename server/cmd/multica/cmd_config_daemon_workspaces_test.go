package main

import (
	"reflect"
	"testing"

	"github.com/multica-ai/multica/server/internal/cli"
)

func TestApplyConfigSetDaemonWorkspaces(t *testing.T) {
	var cfg cli.CLIConfig
	if err := applyConfigSet(&cfg, "daemon_workspaces", " ws-a, ws-b ,,ws-a "); err != nil {
		t.Fatalf("applyConfigSet: %v", err)
	}
	if want := []string{"ws-a", "ws-b"}; !reflect.DeepEqual(cfg.DaemonWorkspaces, want) {
		t.Fatalf("DaemonWorkspaces = %v, want %v", cfg.DaemonWorkspaces, want)
	}
	if err := applyConfigSet(&cfg, "daemon_workspaces", ""); err != nil {
		t.Fatalf("applyConfigSet clear: %v", err)
	}
	if cfg.DaemonWorkspaces != nil {
		t.Fatalf("DaemonWorkspaces after clear = %v, want nil", cfg.DaemonWorkspaces)
	}
}

func TestDaemonWorkspaceAllowlistResolverRereadsConfig(t *testing.T) {
	redirectTestHome(t, t.TempDir())
	t.Setenv("MULTICA_DAEMON_WORKSPACES", "")

	resolve := daemonWorkspaceAllowlistResolver("dev")
	if got := resolve(); len(got) != 0 {
		t.Fatalf("initial allowlist = %v, want empty", got)
	}
	if err := cli.SaveCLIConfigForProfile(cli.CLIConfig{DaemonWorkspaces: []string{"ws-a"}}, "dev"); err != nil {
		t.Fatalf("save config: %v", err)
	}
	if got := resolve(); !reflect.DeepEqual(got, []string{"ws-a"}) {
		t.Fatalf("allowlist after config edit = %v, want [ws-a]", got)
	}
}

func TestDaemonWorkspaceAllowlistResolverEnvWins(t *testing.T) {
	redirectTestHome(t, t.TempDir())
	if err := cli.SaveCLIConfigForProfile(cli.CLIConfig{DaemonWorkspaces: []string{"ws-file"}}, ""); err != nil {
		t.Fatalf("save config: %v", err)
	}
	t.Setenv("MULTICA_DAEMON_WORKSPACES", "ws-env1,ws-env2")

	got := daemonWorkspaceAllowlistResolver("")()
	if want := []string{"ws-env1", "ws-env2"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("allowlist = %v, want %v", got, want)
	}
}
