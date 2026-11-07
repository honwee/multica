CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_plugin_card_action_message_rule
    ON plugin_card_action (message_id, rule_key);
