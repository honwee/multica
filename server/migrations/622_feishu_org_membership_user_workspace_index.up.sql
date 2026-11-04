CREATE INDEX CONCURRENTLY IF NOT EXISTS feishu_org_membership_user_workspace_idx ON feishu_org_membership (user_id, workspace_id) INCLUDE (active, group_id);
