CREATE TABLE IF NOT EXISTS terminal_command_capture (
  session_id TEXT PRIMARY KEY REFERENCES terminal_sessions(id),
  shell TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS terminal_commands (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES terminal_sessions(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  actor_id TEXT NOT NULL REFERENCES users(id),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  command TEXT NOT NULL,
  redacted INTEGER NOT NULL DEFAULT 0,
  exit_code INTEGER,
  recording_seq INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS terminal_commands_device_time ON terminal_commands(device_id,started_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS terminal_commands_session ON terminal_commands(session_id,id);
