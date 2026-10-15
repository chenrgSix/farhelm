ALTER TABLE users ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1));
ALTER TABLE users ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
CREATE TABLE access_roles (
 id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, description TEXT NOT NULL,
 permissions TEXT NOT NULL, builtin INTEGER NOT NULL DEFAULT 0 CHECK(builtin IN (0,1)),
 revision INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE access_groups (
 id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, description TEXT NOT NULL,
 device_scope TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE user_roles (user_id TEXT NOT NULL REFERENCES users(id), role_id TEXT NOT NULL REFERENCES access_roles(id), PRIMARY KEY(user_id,role_id)) STRICT;
CREATE TABLE group_roles (group_id TEXT NOT NULL REFERENCES access_groups(id) ON DELETE CASCADE, role_id TEXT NOT NULL REFERENCES access_roles(id), PRIMARY KEY(group_id,role_id)) STRICT;
CREATE TABLE group_members (group_id TEXT NOT NULL REFERENCES access_groups(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id), PRIMARY KEY(group_id,user_id)) STRICT;
CREATE INDEX group_members_user ON group_members(user_id);
CREATE INDEX user_roles_role ON user_roles(role_id);
CREATE INDEX group_roles_role ON group_roles(role_id);
INSERT INTO access_roles(id,name,description,permissions,builtin,created_at,updated_at) VALUES
 ('admin','管理员','管理整个平台、用户和所有设备','["devices.read","terminal.connect","tasks.read","tasks.execute","recordings.read","audit.read","health.manage","network.manage"]',1,0,0),
 ('ops','运维人员','操作授权设备、执行命令和管理探测','["devices.read","terminal.connect","tasks.read","tasks.execute","recordings.read","audit.read","health.manage","network.manage"]',1,0,0),
 ('business','业务人员','查看授权设备、任务、录制和审计','["devices.read","tasks.read","recordings.read","audit.read"]',1,0,0),
 ('auditor','审计员','查看授权设备、任务、录制和审计','["devices.read","tasks.read","recordings.read","audit.read"]',1,0,0);
INSERT INTO user_roles(user_id,role_id) SELECT id,role FROM users;
