CREATE TABLE IF NOT EXISTS device_network_routes (
  device_id TEXT PRIMARY KEY REFERENCES devices(id),
  revision INTEGER NOT NULL,
  config_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
