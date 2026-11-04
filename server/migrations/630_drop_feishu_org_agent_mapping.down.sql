CREATE TABLE IF NOT EXISTS feishu_org_agent_mapping (
    workspace_id UUID NOT NULL,
    group_id     UUID NOT NULL,
    agent_id     UUID NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
