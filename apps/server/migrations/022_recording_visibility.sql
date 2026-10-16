-- Preserve the dedicated audit role; operational and custom roles stay owner-only.
UPDATE access_roles
SET permissions=json_insert(permissions,'$[#]','recordings.read_all'), revision=revision+1
WHERE builtin=1 AND id IN ('admin','auditor')
  AND NOT EXISTS (SELECT 1 FROM json_each(access_roles.permissions) WHERE value='recordings.read_all')
  AND NOT EXISTS (SELECT 1 FROM meta WHERE key='recording_visibility_v1');
INSERT OR IGNORE INTO meta(key,value) VALUES('recording_visibility_v1','1');
CREATE INDEX IF NOT EXISTS terminal_sessions_actor_history ON terminal_sessions(actor_id,created_at DESC,id DESC);
