CREATE TABLE IF NOT EXISTS system_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  platform_server_url TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL REFERENCES users(id)
);
