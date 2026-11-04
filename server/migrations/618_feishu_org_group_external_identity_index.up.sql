CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS feishu_org_group_workspace_kind_external_uidx ON feishu_org_group (workspace_id, kind, external_id);
