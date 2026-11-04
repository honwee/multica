ALTER TABLE member ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;
ALTER TABLE member ADD COLUMN IF NOT EXISTS feishu_managed_role TEXT
    CHECK (feishu_managed_role IN ('owner', 'admin', 'member'));

CREATE TABLE IF NOT EXISTS feishu_org_config (
    workspace_id   UUID NOT NULL,
    installation_id UUID NOT NULL,
    enabled        BOOLEAN NOT NULL,
    revision       BIGINT NOT NULL DEFAULT 1,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feishu_org_group (
    id            UUID NOT NULL DEFAULT gen_random_uuid(),
    workspace_id  UUID NOT NULL,
    kind          TEXT NOT NULL CHECK (kind IN ('department', 'job_title')),
    external_id   TEXT NOT NULL,
    external_name TEXT NOT NULL,
    configured    BOOLEAN NOT NULL DEFAULT true,
    active        BOOLEAN NOT NULL DEFAULT false,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feishu_org_role_mapping (
    workspace_id UUID NOT NULL,
    group_id     UUID NOT NULL,
    role         TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feishu_org_agent_mapping (
    workspace_id UUID NOT NULL,
    group_id     UUID NOT NULL,
    agent_id     UUID NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feishu_org_membership (
    workspace_id UUID NOT NULL,
    group_id     UUID NOT NULL,
    user_id      UUID NOT NULL,
    active       BOOLEAN NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feishu_org_sync_run (
    id               UUID NOT NULL DEFAULT gen_random_uuid(),
    workspace_id     UUID NOT NULL,
    mode             TEXT NOT NULL CHECK (mode IN ('preview', 'replay', 'apply')),
    status           TEXT NOT NULL CHECK (status IN ('preview', 'completed', 'failed')),
    revision         BIGINT NOT NULL,
    snapshot         JSONB NOT NULL DEFAULT '{}'::jsonb,
    plan             JSONB NOT NULL DEFAULT '{}'::jsonb,
    error            TEXT,
    requested_by     UUID NOT NULL,
    replayed_from_id UUID,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at     TIMESTAMPTZ
);
