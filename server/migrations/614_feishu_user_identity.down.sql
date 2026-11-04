DROP INDEX IF EXISTS user_feishu_open_id_unique;
ALTER TABLE "user" DROP COLUMN IF EXISTS feishu_open_id;
