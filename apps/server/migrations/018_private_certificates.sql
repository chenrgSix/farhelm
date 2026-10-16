ALTER TABLE certificate_settings ADD COLUMN mode TEXT NOT NULL DEFAULT 'acme' CHECK(mode IN ('acme','private'));
CREATE TABLE private_certificate_authority (
  id INTEGER PRIMARY KEY CHECK(id=1),
  fingerprint TEXT NOT NULL
);
