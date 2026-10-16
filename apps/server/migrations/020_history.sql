CREATE INDEX IF NOT EXISTS tasks_history ON tasks(created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS tasks_device_history ON tasks(device_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS terminal_sessions_history ON terminal_sessions(created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS audit_actor_history ON audit(actor_id,id DESC);
