-- Seed each installation's directory from the newest complete preview so the
-- catalog stays available, then stop storing a snapshot per run.
INSERT INTO feishu_org_directory (installation_id, snapshot, fetched_at, fetched_by)
SELECT DISTINCT ON (c.installation_id) c.installation_id, r.snapshot, r.created_at, r.requested_by
FROM feishu_org_sync_run r
JOIN feishu_org_config c ON c.workspace_id = r.workspace_id
WHERE r.mode = 'preview' AND r.status = 'preview' AND r.snapshot->>'Complete' = 'true'
ORDER BY c.installation_id, r.created_at DESC, r.id DESC
ON CONFLICT (installation_id) DO NOTHING;
ALTER TABLE feishu_org_sync_run DROP COLUMN IF EXISTS snapshot;
