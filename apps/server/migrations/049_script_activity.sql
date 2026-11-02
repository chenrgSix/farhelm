-- An uncertain task stays a blocker until its exact execution has been reviewed.
CREATE TABLE IF NOT EXISTS device_script_reviews (
  task_id TEXT PRIMARY KEY REFERENCES device_script_tasks(task_id)
) STRICT;
CREATE INDEX IF NOT EXISTS device_script_tasks_script ON device_script_tasks(script_id,task_id);
CREATE VIEW IF NOT EXISTS device_script_activity AS
  SELECT s.script_id,t.device_id,t.id AS task_id,u.username AS actor_username,
         t.status,t.created_at,s.backend
  FROM tasks t JOIN device_script_tasks s ON s.task_id=t.id
  JOIN device_scripts b ON b.id=s.script_id AND b.device_id=t.device_id
  JOIN users u ON u.id=t.actor_id
  WHERE t.status IN ('QUEUED','SENT','ACCEPTED','RUNNING','UNKNOWN')
    AND NOT EXISTS (SELECT 1 FROM device_script_reviews r WHERE r.task_id=t.id);
