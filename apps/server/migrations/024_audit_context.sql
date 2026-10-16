ALTER TABLE audit ADD COLUMN actor_username TEXT;
ALTER TABLE audit ADD COLUMN device_name TEXT;
ALTER TABLE audit ADD COLUMN target_name TEXT;
ALTER TABLE audit ADD COLUMN request_context TEXT;
