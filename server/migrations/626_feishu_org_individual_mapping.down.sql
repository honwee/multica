ALTER TABLE feishu_org_group DROP CONSTRAINT IF EXISTS feishu_org_group_kind_check;
ALTER TABLE feishu_org_group
    ADD CONSTRAINT feishu_org_group_kind_check CHECK (kind IN ('department', 'job_title'));
