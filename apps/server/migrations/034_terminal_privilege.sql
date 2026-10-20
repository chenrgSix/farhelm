CREATE TABLE IF NOT EXISTS agent_terminal_privilege (
  device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0,
  desired_enabled INTEGER CHECK(desired_enabled IN (0,1)),
  observed_revision INTEGER,
  observed_enabled INTEGER CHECK(observed_enabled IN (0,1)),
  blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0,1)),
  status TEXT NOT NULL DEFAULT 'unknown' CHECK(status IN ('unknown','pending','applied','failed')),
  reason TEXT,
  updated_at INTEGER NOT NULL
) STRICT;
