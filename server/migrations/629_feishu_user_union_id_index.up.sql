CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS user_feishu_union_id_unique ON "user"(feishu_union_id) WHERE feishu_union_id IS NOT NULL;
