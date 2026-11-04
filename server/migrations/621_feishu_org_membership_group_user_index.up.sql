CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS feishu_org_membership_group_user_uidx ON feishu_org_membership (group_id, user_id);
