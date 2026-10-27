DROP TABLE IF EXISTS feishu_org_sync_run;
DROP TABLE IF EXISTS feishu_org_membership;
DROP TABLE IF EXISTS feishu_org_agent_mapping;
DROP TABLE IF EXISTS feishu_org_role_mapping;
DROP TABLE IF EXISTS feishu_org_group;
DROP TABLE IF EXISTS feishu_org_config;
ALTER TABLE member DROP COLUMN IF EXISTS feishu_managed_role;
ALTER TABLE member DROP COLUMN IF EXISTS disabled_at;
