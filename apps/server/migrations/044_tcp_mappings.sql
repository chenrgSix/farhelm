CREATE TABLE IF NOT EXISTS tcp_mappings (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id),
  config_json TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>=1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS tcp_mappings_device ON tcp_mappings(device_id);
