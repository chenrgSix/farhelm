CREATE TABLE IF NOT EXISTS device_disks (
  device_id TEXT PRIMARY KEY REFERENCES devices(id),
  interval_hours INTEGER NOT NULL DEFAULT 24 CHECK(interval_hours IN (1,2,8,12,24)),
  revision INTEGER NOT NULL DEFAULT 0,
  snapshot_json TEXT,
  checked_at INTEGER,
  last_attempt_at INTEGER,
  last_error TEXT,
  next_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS device_disks_due ON device_disks(next_at);
