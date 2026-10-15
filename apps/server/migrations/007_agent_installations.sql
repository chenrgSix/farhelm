CREATE TABLE IF NOT EXISTS agent_installations (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE REFERENCES enrollment_tokens(token_hash),
  config_json TEXT NOT NULL
);
