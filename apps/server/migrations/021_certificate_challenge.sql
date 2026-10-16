ALTER TABLE certificate_settings ADD COLUMN challenge_type TEXT NOT NULL DEFAULT 'http-01' CHECK(challenge_type IN ('http-01','tls-alpn-01'));
