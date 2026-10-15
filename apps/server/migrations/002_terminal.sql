CREATE TABLE IF NOT EXISTS terminal_sessions (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id),
  actor_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL,
  cols INTEGER NOT NULL,
  rows INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  ended_at INTEGER,
  reason TEXT,
  audit_complete INTEGER NOT NULL DEFAULT 0,
  last_seq INTEGER NOT NULL DEFAULT 0,
  output_seq INTEGER NOT NULL DEFAULT 0,
  output_bytes INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX IF NOT EXISTS terminal_sessions_device ON terminal_sessions(device_id,created_at);
CREATE TABLE IF NOT EXISTS terminal_recordings (
  session_id TEXT NOT NULL REFERENCES terminal_sessions(id),
  seq INTEGER NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY(session_id,seq)
) STRICT;
