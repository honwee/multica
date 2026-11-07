package migrations

import (
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// forkLegacyMigrationStems lists the Lumist fork migrations that were deployed
// to production before the fork adopted its own numbering range (see FORK.md).
// Their numbers overlap upstream's 614+ range; schema_migrations records the
// full stem, so both sides apply and these stems must never be renamed. New
// fork migrations start at 90000 and are not listed here.
var forkLegacyMigrationStems = map[string]bool{
	"614_feishu_user_identity":                        true,
	"615_feishu_org_model":                            true,
	"616_feishu_org_config_workspace_index":           true,
	"617_feishu_org_group_id_index":                   true,
	"618_feishu_org_group_external_identity_index":    true,
	"619_feishu_org_role_mapping_group_index":         true,
	"620_feishu_org_agent_mapping_group_agent_index":  true,
	"621_feishu_org_membership_group_user_index":      true,
	"622_feishu_org_membership_user_workspace_index":  true,
	"623_feishu_org_sync_run_id_index":                true,
	"624_feishu_org_sync_run_workspace_created_index": true,
	"625_feishu_org_team_target_comment":              true,
	"626_feishu_org_individual_mapping":               true,
	"627_lark_workspace_app_connection":               true,
	"628_feishu_user_union_identity":                  true,
	"629_feishu_user_union_id_index":                  true,
	"630_drop_feishu_org_agent_mapping":               true,
	"631_feishu_org_directory":                        true,
	"632_feishu_org_directory_installation_index":     true,
	"633_feishu_org_sync_run_drop_snapshot":           true,
	"634_feishu_org_auto_sync":                        true,
	"635_feishu_org_sync_run_directory_version":       true,
	"636_feishu_org_config_source":                    true,
	"637_feishu_org_source_from_bot_binding":          true,
}

// forkPre90000MigrationStems lists fork migrations deployed while the range
// started at 9000. They keep their names. The runner orders files lexically,
// so "90000_" sorts before "9000_": new 90000+ migrations must not depend on
// objects these create.
var forkPre90000MigrationStems = map[string]bool{
	"9000_feishu_org_admit_on_login": true,
}

// firstForkMigrationNumber is where the fork's own migrations start. Five
// digits keep lexical and numeric order the same within the range.
const firstForkMigrationNumber = 90000

// TestForkMigrationsUseTheForkRange rejects new migrations numbered between
// the retired 9000 start and the 90000 range: their lexical order would not
// match their numeric order against the fork range.
func TestForkMigrationsUseTheForkRange(t *testing.T) {
	for _, file := range migrationFilesForLint(t, "*.up.sql") {
		stem, _, ok := splitMigrationFilename(filepath.Base(file))
		if !ok {
			continue
		}
		prefix, _, ok := strings.Cut(stem, "_")
		if !ok {
			continue
		}
		number, err := strconv.Atoi(prefix)
		if err != nil || number < 9000 || forkPre90000MigrationStems[stem] {
			continue
		}
		if number < firstForkMigrationNumber || number > 99999 {
			t.Errorf("migration %s: fork migrations are numbered %d–99999 (see FORK.md)", stem, firstForkMigrationNumber)
		}
	}
}
