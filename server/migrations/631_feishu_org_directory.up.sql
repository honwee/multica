-- One fetched organization directory per Feishu app installation. Workspaces
-- that share the installation read the same directory; sync runs keep only
-- their plan and no longer embed a copy of the whole organization.
CREATE TABLE IF NOT EXISTS feishu_org_directory (
    installation_id UUID NOT NULL,
    snapshot        JSONB NOT NULL DEFAULT '{}'::jsonb,
    fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    fetched_by      UUID,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
