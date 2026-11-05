-- name: GetFeishuOrgConfig :one
SELECT * FROM feishu_org_config
WHERE workspace_id = $1;

-- name: LockFeishuOrgPermissionWrites :exec
SELECT pg_advisory_xact_lock(hashtext($1::text));

-- name: UpsertFeishuOrgConfig :one
INSERT INTO feishu_org_config (workspace_id, installation_id, enabled, auto_sync, updated_by)
VALUES (@workspace_id, @installation_id, @enabled, @auto_sync, @updated_by)
ON CONFLICT (workspace_id) DO UPDATE SET
    installation_id = EXCLUDED.installation_id,
    enabled = EXCLUDED.enabled,
    auto_sync = EXCLUDED.auto_sync,
    updated_by = EXCLUDED.updated_by,
    revision = feishu_org_config.revision + 1,
    updated_at = now()
RETURNING *;

-- name: ListEnabledFeishuOrgConfigs :many
-- Every workspace whose sync is on, grouped by installation so the scheduler
-- fetches each directory once.
SELECT * FROM feishu_org_config
WHERE enabled
ORDER BY installation_id, workspace_id;

-- name: ListActiveOwnerUserIDs :many
SELECT user_id FROM member
WHERE workspace_id = $1 AND role = 'owner' AND disabled_at IS NULL
ORDER BY created_at ASC;

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

-- name: ListActiveFeishuOrgGroups :many
-- Groups that currently grant access: applied (active) and still configured.
-- Members read these to pick team targets for their own agents.
SELECT * FROM feishu_org_group
WHERE workspace_id = $1 AND active AND configured
ORDER BY kind, external_name, external_id;

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

-- name: DeleteAgentInvocationTarget :exec
DELETE FROM agent_invocation_target
WHERE agent_id = @agent_id
  AND target_type = @target_type
  AND target_id = @target_id;

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
    workspace_id, mode, status, revision, plan, requested_by, replayed_from_id, directory_fetched_at
) VALUES (
    @workspace_id, @mode, @status, @revision, @plan, @requested_by, @replayed_from_id, @directory_fetched_at
)
RETURNING *;

-- name: UpsertFeishuOrgDirectory :one
-- The directory is shared by every workspace configured on the installation.
INSERT INTO feishu_org_directory (installation_id, snapshot, fetched_at, fetched_by)
VALUES (@installation_id, @snapshot, now(), @fetched_by)
ON CONFLICT (installation_id) DO UPDATE SET
    snapshot = EXCLUDED.snapshot,
    fetched_at = now(),
    fetched_by = EXCLUDED.fetched_by,
    updated_at = now()
RETURNING *;

-- name: GetFeishuOrgDirectory :one
SELECT * FROM feishu_org_directory
WHERE installation_id = $1;

-- name: GetFeishuOrgDirectoryForWorkspace :one
SELECT d.*
FROM feishu_org_directory d
JOIN feishu_org_config c ON c.installation_id = d.installation_id
WHERE c.workspace_id = $1;

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
    u.feishu_union_id,
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
deleted_role_mappings AS (
    DELETE FROM feishu_org_role_mapping WHERE workspace_id = $1
),
deleted_groups AS (
    DELETE FROM feishu_org_group WHERE workspace_id = $1
)
DELETE FROM feishu_org_config WHERE feishu_org_config.workspace_id = $1;

-- name: GetFeishuOrgBootstrapSource :one
SELECT c.*
FROM feishu_org_config c
JOIN member m
  ON m.workspace_id = c.workspace_id
 AND m.user_id = @user_id
 AND m.disabled_at IS NULL
 AND m.role IN ('owner', 'admin')
JOIN channel_installation ci
  ON ci.id = c.installation_id
 AND ci.workspace_id = c.workspace_id
 AND ci.channel_type = 'feishu'
 AND ci.status = 'active'
WHERE c.enabled
ORDER BY c.updated_at DESC, c.workspace_id DESC
LIMIT 1;

-- name: CloneFeishuOrgGroups :exec
INSERT INTO feishu_org_group (workspace_id, kind, external_id, external_name, configured, active)
SELECT @target_workspace_id, kind, external_id, external_name, configured, active
FROM feishu_org_group source_rows
WHERE source_rows.workspace_id = @source_workspace_id;

-- name: CloneFeishuOrgRoleMappings :exec
INSERT INTO feishu_org_role_mapping (workspace_id, group_id, role)
SELECT @target_workspace_id, target_group.id, mapping.role
FROM feishu_org_role_mapping mapping
JOIN feishu_org_group source_group
  ON source_group.id = mapping.group_id
 AND source_group.workspace_id = @source_workspace_id
JOIN feishu_org_group target_group
  ON target_group.workspace_id = @target_workspace_id
 AND target_group.kind = source_group.kind
 AND target_group.external_id = source_group.external_id;

-- name: CloneFeishuOrgMemberships :exec
INSERT INTO feishu_org_membership (workspace_id, group_id, user_id, active)
SELECT @target_workspace_id, target_group.id, membership.user_id, membership.active
FROM feishu_org_membership membership
JOIN feishu_org_group source_group
  ON source_group.id = membership.group_id
 AND source_group.workspace_id = @source_workspace_id
JOIN feishu_org_group target_group
  ON target_group.workspace_id = @target_workspace_id
 AND target_group.kind = source_group.kind
 AND target_group.external_id = source_group.external_id;

-- name: GetFeishuOrgInstallationForWorkspace :one
-- A workspace may use its own installation, or one shared by the source
-- workspace whose organization sync is enabled. The requesting workspace's
-- own enabled flag is deliberately not a condition: a workspace that turned
-- sync off must still be able to turn it back on.
SELECT ci.*
FROM channel_installation ci
WHERE ci.id = @installation_id
  AND ci.channel_type = 'feishu'
  AND (
    ci.workspace_id = @workspace_id
    OR EXISTS (
      SELECT 1
      FROM feishu_org_config shared
      JOIN feishu_org_config source
        ON source.installation_id = shared.installation_id
       AND source.workspace_id = ci.workspace_id
       AND source.enabled
      WHERE shared.workspace_id = @workspace_id
        AND shared.installation_id = ci.id
    )
  );
