CREATE TABLE IF NOT EXISTS target_account_groups (
  account_id TEXT NOT NULL REFERENCES target_accounts(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES access_groups(id) ON DELETE CASCADE,
  PRIMARY KEY(account_id,group_id)
) STRICT;
CREATE INDEX IF NOT EXISTS target_account_groups_group ON target_account_groups(group_id);
CREATE TABLE IF NOT EXISTS target_account_roles (
  account_id TEXT NOT NULL REFERENCES target_accounts(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES access_roles(id) ON DELETE CASCADE,
  PRIMARY KEY(account_id,role_id)
) STRICT;
CREATE INDEX IF NOT EXISTS target_account_roles_role ON target_account_roles(role_id);
