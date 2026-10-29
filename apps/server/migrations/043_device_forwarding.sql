CREATE TABLE IF NOT EXISTS device_forwarding (
  device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  revision INTEGER NOT NULL CHECK(revision>=1),
  updated_at INTEGER NOT NULL
) STRICT;
