-- Organization data no longer follows a Bot binding. A config that reads from
-- an installation bound to an agent moves to the login app; installations
-- connected only for organization data (agent_id IS NULL) keep their config.
UPDATE feishu_org_config c
SET source = 'login_app',
    installation_id = NULL,
    revision = c.revision + 1,
    updated_at = now()
FROM channel_installation ci
WHERE c.source = 'installation'
  AND ci.id = c.installation_id
  AND ci.agent_id IS NOT NULL;
