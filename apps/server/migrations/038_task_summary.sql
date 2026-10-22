CREATE INDEX IF NOT EXISTS tasks_unresolved_scope ON tasks(device_id,actor_id,status) WHERE status IN ('QUEUED','SENT','ACCEPTED','RUNNING','UNKNOWN');
