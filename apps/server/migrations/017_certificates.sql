CREATE TABLE IF NOT EXISTS certificate_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  revision INTEGER NOT NULL,
  domain TEXT NOT NULL,
  email TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  tos_agreed INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_attempt_at INTEGER,
  last_success_at INTEGER,
  next_attempt_at INTEGER,
  retry_after INTEGER,
  last_error TEXT,
  failures INTEGER NOT NULL DEFAULT 0
);
