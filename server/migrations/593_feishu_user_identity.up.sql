ALTER TABLE "user" ADD COLUMN IF NOT EXISTS feishu_open_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS user_feishu_open_id_unique
    ON "user"(feishu_open_id)
    WHERE feishu_open_id IS NOT NULL;
