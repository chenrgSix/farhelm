CREATE TABLE IF NOT EXISTS default_account_policies (
  device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE
) STRICT;
CREATE TABLE IF NOT EXISTS account_authorizations (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  account_id TEXT REFERENCES target_accounts(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  group_id TEXT REFERENCES access_groups(id) ON DELETE CASCADE,
  role_id TEXT REFERENCES access_roles(id) ON DELETE CASCADE,
  inherit_scope INTEGER NOT NULL DEFAULT 0 CHECK(inherit_scope IN (0,1)),
  legacy_scope INTEGER NOT NULL DEFAULT 0 CHECK(legacy_scope IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1,
  CHECK((user_id IS NOT NULL)+(group_id IS NOT NULL)+(role_id IS NOT NULL)+inherit_scope=1),
  CHECK(inherit_scope=0 OR account_id IS NULL)
) STRICT;
CREATE INDEX IF NOT EXISTS account_authorizations_device ON account_authorizations(device_id,account_id);
CREATE INDEX IF NOT EXISTS account_authorizations_user ON account_authorizations(user_id);
CREATE INDEX IF NOT EXISTS account_authorizations_group ON account_authorizations(group_id);
CREATE INDEX IF NOT EXISTS account_authorizations_role ON account_authorizations(role_id);
