ALTER TABLE feishu_org_config ADD COLUMN IF NOT EXISTS auto_sync BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE feishu_org_config ADD COLUMN IF NOT EXISTS updated_by UUID;
ALTER TABLE feishu_org_sync_run DROP CONSTRAINT IF EXISTS feishu_org_sync_run_mode_check;
ALTER TABLE feishu_org_sync_run
    ADD CONSTRAINT feishu_org_sync_run_mode_check CHECK (mode IN ('preview', 'replay', 'apply', 'auto'));
