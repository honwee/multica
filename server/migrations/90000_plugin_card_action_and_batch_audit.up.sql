-- Fork extension points for workspace plugins (see FORK.md): plugin-defined
-- buttons on Feishu notification cards, and batch issue operations from a
-- plugin workspace page. Both are off unless a workspace turns them on in
-- workspace.settings.plugin_extensions.
--
-- Relationships are application-owned by repository policy: no foreign keys
-- or cascades. Workspace deletion clears both tables in
-- DeleteWorkspacePluginData.

-- One row per decision on one Feishu card. The unique (message_id, rule_key)
-- index is the idempotency guard: repeated clicks on the same card, and Lark
-- redelivering the same callback, claim the same row and execute once.
CREATE TABLE IF NOT EXISTS plugin_card_action (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    installation_id UUID NOT NULL,
    issue_id UUID NOT NULL,
    -- Lark open_message_id of the card that was clicked.
    message_id TEXT NOT NULL CHECK (char_length(message_id) BETWEEN 1 AND 128),
    rule_key TEXT NOT NULL CHECK (char_length(rule_key) BETWEEN 1 AND 128),
    button_key TEXT NOT NULL CHECK (char_length(button_key) BETWEEN 1 AND 128),
    user_id UUID NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed')),
    -- Host-written summary shown on the updated card, e.g. "已同意". Never a
    -- hook response body.
    result_text TEXT CHECK (result_text IS NULL OR char_length(result_text) <= 200),
    error TEXT CHECK (error IS NULL OR char_length(error) <= 500),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per item of a batch operation a plugin page performed on behalf of
-- the signed-in user. Comments already carry via_plugin_id; status changes go
-- through the ordinary issue update path, which has no plugin attribution, so
-- this table is where via_plugin_id is recorded for both.
CREATE TABLE IF NOT EXISTS plugin_batch_action (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    via_plugin_id UUID NOT NULL,
    user_id UUID NOT NULL,
    issue_ref TEXT NOT NULL CHECK (char_length(issue_ref) BETWEEN 1 AND 128),
    issue_id UUID,
    action TEXT NOT NULL CHECK (action IN ('comment', 'set_status')),
    status TEXT NOT NULL CHECK (status IN ('ok', 'forbidden', 'not_found', 'invalid', 'failed')),
    error TEXT CHECK (error IS NULL OR char_length(error) <= 500),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- card_action joins the hook triggers the invocation log accepts.
ALTER TABLE plugin_invocation DROP CONSTRAINT IF EXISTS plugin_invocation_trigger_check;
ALTER TABLE plugin_invocation ADD CONSTRAINT plugin_invocation_trigger_check
    CHECK (trigger IN ('ui', 'manual', 'event', 'agent', 'schedule', 'card_action')) NOT VALID;
