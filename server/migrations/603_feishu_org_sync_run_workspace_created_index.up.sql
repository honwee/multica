CREATE INDEX CONCURRENTLY IF NOT EXISTS feishu_org_sync_run_workspace_created_idx ON feishu_org_sync_run (workspace_id, created_at DESC);
