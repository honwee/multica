-- A login-app source has no installation to fall back to; those configs are
-- dropped so installation_id can be required again.
DELETE FROM feishu_org_config WHERE installation_id IS NULL;
ALTER TABLE feishu_org_config ALTER COLUMN installation_id SET NOT NULL;
ALTER TABLE feishu_org_config DROP CONSTRAINT IF EXISTS feishu_org_config_source_check;
ALTER TABLE feishu_org_config DROP COLUMN IF EXISTS source;
