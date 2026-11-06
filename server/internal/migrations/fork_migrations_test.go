package migrations

// forkLegacyMigrationStems lists the Lumist fork migrations that were deployed
// to production before the fork adopted the 9000+ numbering rule (see FORK.md).
// Their numbers overlap upstream's 614+ range; schema_migrations records the
// full stem, so both sides apply and these stems must never be renamed. New
// fork migrations start at 9000 and are not listed here.
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
