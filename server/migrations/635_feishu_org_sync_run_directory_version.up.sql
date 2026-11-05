-- The directory a preview was planned against; apply refuses to run when the
-- shared directory has been refreshed since.
ALTER TABLE feishu_org_sync_run ADD COLUMN IF NOT EXISTS directory_fetched_at TIMESTAMPTZ;
