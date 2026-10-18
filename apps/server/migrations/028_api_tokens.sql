CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  permissions TEXT NOT NULL,
  device_scope TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER,
  last_used_address TEXT,
  revision INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS api_tokens_owner ON api_tokens(owner_id, created_at);
