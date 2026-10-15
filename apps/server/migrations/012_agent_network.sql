CREATE TABLE IF NOT EXISTS agent_network (
  device_id TEXT PRIMARY KEY REFERENCES devices(id),
  snapshot TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_network_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL REFERENCES devices(id),
  event_id TEXT NOT NULL,
  event TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  UNIQUE(device_id,event_id)
);
CREATE INDEX IF NOT EXISTS agent_network_history ON agent_network_events(device_id,sequence DESC);
