CREATE TABLE IF NOT EXISTS device_scripts (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id),
  name TEXT NOT NULL, script TEXT NOT NULL, revision INTEGER NOT NULL,
  UNIQUE(device_id,name)
) STRICT;
-- Keep the execution snapshot even after an administrator changes or deletes the button.
CREATE TABLE IF NOT EXISTS device_script_tasks (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id), script_id TEXT NOT NULL,
  revision INTEGER NOT NULL, name TEXT NOT NULL, backend TEXT NOT NULL CHECK(backend IN ('ssh','agent'))
) STRICT;
CREATE INDEX IF NOT EXISTS device_script_tasks_backend ON device_script_tasks(backend,task_id);
UPDATE access_roles SET permissions=json_insert(permissions,'$[#]','scripts.run'), revision=revision+1
WHERE id='admin' AND builtin=1 AND NOT EXISTS (SELECT 1 FROM json_each(permissions) WHERE value='scripts.run');
