ALTER TABLE connection_limits ADD COLUMN terminal_max_minutes INTEGER NOT NULL DEFAULT 60
  CHECK (terminal_max_minutes BETWEEN 0 AND 150119987579);
