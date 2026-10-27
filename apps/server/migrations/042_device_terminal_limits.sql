CREATE TABLE IF NOT EXISTS device_terminal_limits (
  device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  terminal_limit INTEGER CHECK(terminal_limit IS NULL OR terminal_limit BETWEEN 1 AND 128),
  revision INTEGER NOT NULL CHECK(revision>=1),
  updated_at INTEGER NOT NULL
) STRICT;
