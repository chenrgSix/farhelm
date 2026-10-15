ALTER TABLE terminal_sessions ADD COLUMN transport TEXT NOT NULL DEFAULT 'web' CHECK(transport IN ('web','ssh'));
