DELETE FROM plugin_invocation WHERE trigger = 'card_action';
ALTER TABLE plugin_invocation DROP CONSTRAINT IF EXISTS plugin_invocation_trigger_check;
ALTER TABLE plugin_invocation ADD CONSTRAINT plugin_invocation_trigger_check
    CHECK (trigger IN ('ui', 'manual', 'event', 'agent', 'schedule')) NOT VALID;
DROP TABLE IF EXISTS plugin_batch_action;
DROP TABLE IF EXISTS plugin_card_action;
