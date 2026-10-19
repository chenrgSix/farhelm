CREATE TABLE IF NOT EXISTS target_accounts (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id),
  name TEXT NOT NULL,
  username TEXT NOT NULL,
  method TEXT NOT NULL CHECK(method IN ('ssh','sudo')),
  revision INTEGER NOT NULL,
  allowed_users TEXT NOT NULL,
  secrets TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS target_accounts_device ON target_accounts(device_id);
-- New privileged-account permission is opt-in for all custom roles.
UPDATE access_roles SET permissions=json_insert(permissions,'$[#]','terminal.sudo'),revision=revision+1
WHERE id='admin' AND NOT EXISTS (SELECT 1 FROM json_each(access_roles.permissions) WHERE value='terminal.sudo');
