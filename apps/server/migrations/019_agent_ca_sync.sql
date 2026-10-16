CREATE TABLE agent_ca_capabilities (
  device_id TEXT PRIMARY KEY REFERENCES devices(id),
  supported INTEGER NOT NULL,
  fingerprints_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE agent_ca_rollout (
  id INTEGER PRIMARY KEY CHECK(id=1),
  revision INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  ca_pem TEXT NOT NULL,
  proof_pem TEXT NOT NULL,
  server_name TEXT NOT NULL
);
CREATE TABLE agent_ca_sync (
  device_id TEXT PRIMARY KEY REFERENCES devices(id),
  revision INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  request_id TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  updated_at INTEGER NOT NULL
);
