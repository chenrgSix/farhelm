CREATE TABLE IF NOT EXISTS health_configs (
  device_id TEXT PRIMARY KEY REFERENCES devices(id),
  revision INTEGER NOT NULL,
  checks_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id)
) STRICT;
CREATE TABLE IF NOT EXISTS health_results (
  device_id TEXT NOT NULL REFERENCES devices(id),
  check_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  connection_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  healthy INTEGER,
  failures INTEGER NOT NULL,
  reason TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  PRIMARY KEY(device_id,check_id)
) STRICT;
