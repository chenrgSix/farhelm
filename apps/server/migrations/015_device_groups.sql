-- Device groups are optional, many-to-many classification tags. They never grant access.
CREATE TABLE device_groups (
 id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, description TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE device_group_members (
 device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
 group_id TEXT NOT NULL REFERENCES device_groups(id) ON DELETE CASCADE,
 PRIMARY KEY(device_id,group_id)
) STRICT;
CREATE INDEX device_group_members_group ON device_group_members(group_id);
CREATE TRIGGER device_group_member_added AFTER INSERT ON device_group_members BEGIN
 UPDATE device_groups SET revision=revision+1 WHERE id=NEW.group_id;
END;
CREATE TRIGGER device_group_member_removed AFTER DELETE ON device_group_members BEGIN
 UPDATE device_groups SET revision=revision+1 WHERE id=OLD.group_id;
END;
