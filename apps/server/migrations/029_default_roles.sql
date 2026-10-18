-- Keep role IDs and all existing grants stable. Unused legacy defaults can go;
-- assigned roles become ordinary custom roles without changing permissions.
DELETE FROM access_roles
WHERE builtin=1 AND id IN ('ops','auditor')
  AND NOT EXISTS (SELECT 1 FROM user_roles WHERE role_id=access_roles.id)
  AND NOT EXISTS (SELECT 1 FROM group_roles WHERE role_id=access_roles.id)
  AND NOT EXISTS (SELECT 1 FROM meta WHERE key='default_roles_v2');

UPDATE access_roles SET builtin=0, revision=revision+1
WHERE builtin=1 AND id IN ('ops','auditor')
  AND NOT EXISTS (SELECT 1 FROM meta WHERE key='default_roles_v2');

-- A custom role may already use the new display name. Preserve it and choose
-- an unused label for the built-in role instead of failing startup or renaming it.
WITH RECURSIVE labels(n,name) AS (
  SELECT 0,'普通用户'
  UNION ALL
  SELECT n+1,'普通用户（内置 ' || (n+1) || '）' FROM labels
  WHERE EXISTS (SELECT 1 FROM access_roles WHERE id<>'business' AND name=labels.name COLLATE NOCASE)
)
UPDATE access_roles
SET name=(SELECT name FROM labels ORDER BY n DESC LIMIT 1),
    description='只读查看授权设备、本人任务、本人会话与录制、本人操作审计',
    revision=revision+1
WHERE id='business' AND builtin=1
  AND NOT EXISTS (SELECT 1 FROM meta WHERE key='default_roles_v2');

INSERT OR IGNORE INTO meta(key,value) VALUES('default_roles_v2','1');
