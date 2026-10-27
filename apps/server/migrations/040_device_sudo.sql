CREATE TABLE IF NOT EXISTS device_sudo_rules (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  group_id TEXT REFERENCES access_groups(id) ON DELETE CASCADE,
  role_id TEXT REFERENCES access_roles(id) ON DELETE CASCADE,
  effect TEXT NOT NULL CHECK(effect IN ('allow','deny')),
  origin TEXT NOT NULL DEFAULT 'explicit' CHECK(origin IN ('explicit','legacy')),
  legacy_role_ids TEXT NOT NULL DEFAULT '[]',
  revision INTEGER NOT NULL DEFAULT 1,
  CHECK((user_id IS NOT NULL)+(group_id IS NOT NULL)+(role_id IS NOT NULL)=1),
  CHECK(effect='allow' OR user_id IS NOT NULL),
  CHECK(origin='explicit' OR user_id IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS device_sudo_user ON device_sudo_rules(device_id,user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS device_sudo_group ON device_sudo_rules(device_id,group_id) WHERE group_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS device_sudo_role ON device_sudo_rules(device_id,role_id) WHERE role_id IS NOT NULL;
