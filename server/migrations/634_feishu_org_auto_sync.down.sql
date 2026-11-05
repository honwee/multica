DELETE FROM feishu_org_sync_run WHERE mode = 'auto';
ALTER TABLE feishu_org_sync_run DROP CONSTRAINT IF EXISTS feishu_org_sync_run_mode_check;
ALTER TABLE feishu_org_sync_run
    ADD CONSTRAINT feishu_org_sync_run_mode_check CHECK (mode IN ('preview', 'replay', 'apply'));
ALTER TABLE feishu_org_config DROP COLUMN IF EXISTS updated_by;
ALTER TABLE feishu_org_config DROP COLUMN IF EXISTS auto_sync;
