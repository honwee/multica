-- Whether a Feishu sign-in matching an organization rule joins the workspace
-- without an invitation. Independent of auto_sync, which only keeps existing
-- members' roles and groups current.
ALTER TABLE feishu_org_config ADD COLUMN IF NOT EXISTS admit_on_login BOOLEAN NOT NULL DEFAULT false;
