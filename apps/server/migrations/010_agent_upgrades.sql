CREATE TABLE IF NOT EXISTS agent_runtime (
 device_id TEXT PRIMARY KEY REFERENCES devices(id),
 arch TEXT NOT NULL, sha256 TEXT NOT NULL, version TEXT NOT NULL,
 upgrade_supported INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_upgrade_batches (
 id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES users(id),
 request_json TEXT NOT NULL, concurrency INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_upgrades (
 id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES agent_upgrade_batches(id),
 device_id TEXT NOT NULL REFERENCES devices(id), arch TEXT NOT NULL,
 sha256 TEXT NOT NULL, size INTEGER NOT NULL, version TEXT NOT NULL,
 status TEXT NOT NULL, reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_agent_upgrade ON agent_upgrades(device_id)
 WHERE status NOT IN ('SUCCEEDED','FAILED');
