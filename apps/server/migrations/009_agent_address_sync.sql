CREATE TABLE IF NOT EXISTS agent_address_sync (
  device_id TEXT PRIMARY KEY REFERENCES devices(id),
  revision INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  server_url TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','checking','saved','applied','failed')),
  reason TEXT,
  updated_at INTEGER NOT NULL
);
