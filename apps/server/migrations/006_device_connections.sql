ALTER TABLE devices ADD COLUMN connection_kind TEXT NOT NULL DEFAULT 'agent' CHECK(connection_kind IN ('agent','ssh'));
ALTER TABLE terminal_sessions ADD COLUMN backend TEXT NOT NULL DEFAULT 'agent' CHECK(backend IN ('agent','ssh'));
CREATE TABLE device_connections (
  device_id TEXT PRIMARY KEY REFERENCES devices(id),
  revision INTEGER NOT NULL,
  config_json TEXT NOT NULL,
  secrets TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id),
  last_checked_at INTEGER,
  last_error TEXT
) STRICT;
