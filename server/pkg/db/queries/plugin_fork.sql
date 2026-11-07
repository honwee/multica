-- Fork extension points for workspace plugins. See FORK.md.

-- name: ClaimPluginCardAction :one
-- Claims one decision on one card. Inserts a pending row, or takes over a row
-- whose previous attempt failed or was abandoned (pending past stale_before).
-- Returns no row when the decision is already done or still in flight, which
-- the caller reads with GetPluginCardAction.
INSERT INTO plugin_card_action (
    workspace_id, installation_id, issue_id, message_id, rule_key, button_key, user_id, status
) VALUES (
    @workspace_id, @installation_id, @issue_id, @message_id, @rule_key, @button_key, @user_id, 'pending'
)
ON CONFLICT (message_id, rule_key) DO UPDATE SET
    button_key = EXCLUDED.button_key,
    user_id = EXCLUDED.user_id,
    status = 'pending',
    error = NULL,
    updated_at = now()
WHERE plugin_card_action.status = 'failed'
   OR (plugin_card_action.status = 'pending' AND plugin_card_action.updated_at < @stale_before)
RETURNING *;

-- name: GetPluginCardAction :one
SELECT * FROM plugin_card_action
WHERE message_id = $1 AND rule_key = $2;

-- name: FinishPluginCardAction :one
UPDATE plugin_card_action
SET status = @status,
    result_text = sqlc.narg('result_text'),
    error = sqlc.narg('error'),
    updated_at = now()
WHERE id = @id
RETURNING *;

-- name: CreatePluginBatchAction :exec
INSERT INTO plugin_batch_action (
    workspace_id, via_plugin_id, user_id, issue_ref, issue_id, action, status, error
) VALUES (
    @workspace_id, @via_plugin_id, @user_id, @issue_ref, sqlc.narg('issue_id'), @action, @status, sqlc.narg('error')
);

-- name: ListPluginBatchActions :many
SELECT * FROM plugin_batch_action
WHERE workspace_id = $1 AND via_plugin_id = $2
ORDER BY created_at DESC
LIMIT $3;
