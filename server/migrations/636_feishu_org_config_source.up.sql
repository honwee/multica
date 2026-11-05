-- Where a workspace's organization data comes from. 'login_app' reads it with
-- the deployment's Feishu login app (FEISHU_APP_ID / FEISHU_APP_SECRET from the
-- environment, never stored); 'installation' reads it with a connected
-- channel_installation and keeps installation_id.
ALTER TABLE feishu_org_config ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'installation';
ALTER TABLE feishu_org_config DROP CONSTRAINT IF EXISTS feishu_org_config_source_check;
ALTER TABLE feishu_org_config
    ADD CONSTRAINT feishu_org_config_source_check CHECK (source IN ('login_app', 'installation'));
ALTER TABLE feishu_org_config ALTER COLUMN installation_id DROP NOT NULL;
