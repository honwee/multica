-- name: GetFeishuOrgConfig :one
SELECT * FROM feishu_org_config
WHERE workspace_id = $1;

-- name: LockFeishuOrgPermissionWrites :exec
SELECT pg_advisory_xact_lock(hashtext($1::text));

-- name: UpsertFeishuOrgConfig :one
INSERT INTO feishu_org_config (workspace_id, installation_id, enabled)
VALUES (@workspace_id, @installation_id, @enabled)
ON CONFLICT (workspace_id) DO UPDATE SET
    installation_id = EXCLUDED.installation_id,
    enabled = EXCLUDED.enabled,
    revision = feishu_org_config.revision + 1,
    updated_at = now()
RETURNING *;

-- name: UpsertFeishuOrgGroup :one
INSERT INTO feishu_org_group (workspace_id, kind, external_id, external_name, configured, active)
VALUES (@workspace_id, @kind, @external_id, @external_name, true, false)
ON CONFLICT (workspace_id, kind, external_id) DO UPDATE SET
    external_name = EXCLUDED.external_name,
    configured = true,
    updated_at = now()
RETURNING *;

-- name: ListFeishuOrgGroups :many
SELECT * FROM feishu_org_group
WHERE workspace_id = $1
ORDER BY kind, external_id;

-- name: DeactivateFeishuOrgGroupsNotIn :exec
UPDATE feishu_org_group
SET configured = false, updated_at = now()
WHERE workspace_id = @workspace_id
  AND configured
  AND NOT (id = ANY(@ids::uuid[]));

-- name: ApplyFeishuOrgGroupStates :exec
UPDATE feishu_org_group
SET active = configured, updated_at = now()
WHERE workspace_id = $1
  AND active <> configured;

-- name: ListFeishuOrgRoleMappings :many
SELECT * FROM feishu_org_role_mapping
WHERE workspace_id = $1
ORDER BY created_at, group_id;

-- name: DeleteFeishuOrgRoleMappings :exec
DELETE FROM feishu_org_role_mapping
WHERE workspace_id = $1;

-- name: CreateFeishuOrgRoleMapping :one
INSERT INTO feishu_org_role_mapping (workspace_id, group_id, role)
VALUES (@workspace_id, @group_id, @role)
RETURNING *;

-- name: ListFeishuOrgAgentMappings :many
SELECT * FROM feishu_org_agent_mapping
WHERE workspace_id = $1
ORDER BY created_at, group_id, agent_id;

-- name: ListFeishuOrgAgentTargets :many
SELECT ait.agent_id, ait.target_id AS group_id
FROM agent_invocation_target ait
JOIN agent a ON a.id = ait.agent_id
JOIN feishu_org_group g
  ON g.id = ait.target_id
 AND g.workspace_id = a.workspace_id
WHERE a.workspace_id = $1
  AND ait.target_type = 'team'
ORDER BY ait.agent_id, ait.target_id;

-- name: DeleteFeishuOrgAgentMappings :exec
DELETE FROM feishu_org_agent_mapping
WHERE workspace_id = $1;

-- name: CreateFeishuOrgAgentMapping :one
INSERT INTO feishu_org_agent_mapping (workspace_id, group_id, agent_id)
VALUES (@workspace_id, @group_id, @agent_id)
RETURNING *;

-- name: DeleteAgentInvocationTarget :exec
DELETE FROM agent_invocation_target
WHERE agent_id = @agent_id
  AND target_type = @target_type
  AND target_id = @target_id;

-- name: SetAgentPublicTo :one
UPDATE agent
SET permission_mode = 'public_to', updated_at = now()
WHERE id = @id AND workspace_id = @workspace_id
RETURNING *;

-- name: UpsertFeishuOrgMembership :one
INSERT INTO feishu_org_membership (workspace_id, group_id, user_id, active)
VALUES (@workspace_id, @group_id, @user_id, @active)
ON CONFLICT (group_id, user_id) DO UPDATE SET
    active = EXCLUDED.active,
    updated_at = now()
RETURNING *;

-- name: ListFeishuOrgMemberships :many
SELECT * FROM feishu_org_membership
WHERE workspace_id = $1
ORDER BY group_id, user_id;

-- name: IsFeishuOrgTeamMember :one
SELECT EXISTS (
    SELECT 1
    FROM feishu_org_membership fom
    JOIN feishu_org_group fog
      ON fog.id = fom.group_id
     AND fog.workspace_id = fom.workspace_id
    JOIN member m
      ON m.workspace_id = fom.workspace_id
     AND m.user_id = fom.user_id
    WHERE fom.group_id = @group_id
      AND fom.workspace_id = @workspace_id
      AND fom.user_id = @user_id
      AND fom.active
      AND fog.active
      AND m.disabled_at IS NULL
);

-- name: ListFeishuOrgTeamIDsForMember :many
SELECT fom.group_id
FROM feishu_org_membership fom
JOIN feishu_org_group fog
  ON fog.id = fom.group_id
 AND fog.workspace_id = fom.workspace_id
JOIN member m
  ON m.workspace_id = fom.workspace_id
 AND m.user_id = fom.user_id
WHERE fom.workspace_id = @workspace_id
  AND fom.user_id = @user_id
  AND fom.active
  AND fog.active
  AND m.disabled_at IS NULL
ORDER BY fom.group_id;

-- name: CreateFeishuOrgSyncRun :one
INSERT INTO feishu_org_sync_run (
    workspace_id, mode, status, revision, snapshot, plan, requested_by, replayed_from_id
) VALUES (
    @workspace_id, @mode, @status, @revision, @snapshot, @plan, @requested_by, @replayed_from_id
)
RETURNING *;

-- name: GetFeishuOrgSyncRunInWorkspace :one
SELECT * FROM feishu_org_sync_run
WHERE id = @id AND workspace_id = @workspace_id;

-- name: ListFeishuOrgSyncRuns :many
SELECT * FROM feishu_org_sync_run
WHERE workspace_id = $1
ORDER BY created_at DESC, id DESC
LIMIT 20;

-- name: UpdateFeishuOrgSyncRun :one
UPDATE feishu_org_sync_run
SET status = @status,
    plan = @plan,
    error = @error,
    completed_at = @completed_at
WHERE id = @id AND workspace_id = @workspace_id
RETURNING *;

-- name: ListFeishuOrgMemberIdentities :many
SELECT
    m.id,
    m.workspace_id,
    m.user_id,
    m.role,
    m.disabled_at,
    m.feishu_managed_role,
    u.name AS user_name,
    u.email AS user_email,
    u.feishu_open_id,
    COALESCE(
        ARRAY_AGG(DISTINCT b.channel_user_id ORDER BY b.channel_user_id)
            FILTER (WHERE b.channel_user_id IS NOT NULL),
        '{}'::text[]
    )::text[] AS channel_open_ids,
    COALESCE(
        ARRAY_AGG(DISTINCT b.config->>'union_id' ORDER BY b.config->>'union_id')
            FILTER (WHERE b.config->>'union_id' IS NOT NULL),
        '{}'::text[]
    )::text[] AS union_ids
FROM member m
JOIN "user" u ON u.id = m.user_id
LEFT JOIN channel_installation ci
  ON ci.workspace_id = m.workspace_id
 AND ci.channel_type = 'feishu'
LEFT JOIN channel_user_binding b
  ON b.installation_id = ci.id
 AND b.workspace_id = m.workspace_id
 AND b.multica_user_id = m.user_id
 AND b.channel_type = 'feishu'
WHERE m.workspace_id = @workspace_id
GROUP BY m.id, u.id
ORDER BY m.created_at, m.id;

-- name: DisableFeishuOrgMember :one
UPDATE member
SET disabled_at = COALESCE(disabled_at, now())
WHERE workspace_id = @workspace_id AND user_id = @user_id
RETURNING *;

-- name: RestoreFeishuOrgMember :one
UPDATE member
SET disabled_at = NULL
WHERE workspace_id = @workspace_id AND user_id = @user_id
RETURNING *;

-- name: UpdateFeishuOrgMemberRole :one
UPDATE member
SET role = @role, feishu_managed_role = @role
WHERE workspace_id = @workspace_id AND user_id = @user_id
RETURNING *;

-- name: SetFeishuOrgManagedRole :one
UPDATE member
SET feishu_managed_role = @feishu_managed_role
WHERE workspace_id = @workspace_id AND user_id = @user_id
RETURNING *;

-- name: DeleteFeishuOrgDataByWorkspace :exec
WITH
deleted_sync_runs AS (
    DELETE FROM feishu_org_sync_run WHERE workspace_id = $1
),
deleted_memberships AS (
    DELETE FROM feishu_org_membership WHERE workspace_id = $1
),
deleted_agent_mappings AS (
    DELETE FROM feishu_org_agent_mapping WHERE workspace_id = $1
),
deleted_role_mappings AS (
    DELETE FROM feishu_org_role_mapping WHERE workspace_id = $1
),
deleted_groups AS (
    DELETE FROM feishu_org_group WHERE workspace_id = $1
)
DELETE FROM feishu_org_config WHERE feishu_org_config.workspace_id = $1;
