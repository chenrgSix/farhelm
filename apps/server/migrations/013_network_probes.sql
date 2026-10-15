CREATE TABLE IF NOT EXISTS network_probe_configs (
  device_id TEXT NOT NULL REFERENCES devices(id),
  revision INTEGER NOT NULL,
  config TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(device_id,revision)
);
CREATE TABLE IF NOT EXISTS network_probe_applied (
  device_id TEXT PRIMARY KEY REFERENCES devices(id),
  revision INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS network_probe_latest (
  device_id TEXT PRIMARY KEY REFERENCES devices(id),
  seq INTEGER NOT NULL,
  report TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  age_ms INTEGER NOT NULL,
  connection_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS network_probe_events (
  device_id TEXT NOT NULL REFERENCES devices(id),
  seq INTEGER NOT NULL,
  sample_id TEXT NOT NULL,
  report TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY(device_id,seq),
  UNIQUE(device_id,sample_id)
);
