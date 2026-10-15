-- Bound installation tokens cannot enroll a second device or choose their own target.
ALTER TABLE enrollment_tokens ADD COLUMN target_device_id TEXT REFERENCES devices(id);
CREATE INDEX enrollment_target ON enrollment_tokens(target_device_id);
-- Keep SSH as the active device kind until the staged identity proves it can connect.
ALTER TABLE devices ADD COLUMN agent_pending_public_key TEXT;
CREATE UNIQUE INDEX device_pending_agent_key ON devices(agent_pending_public_key) WHERE agent_pending_public_key IS NOT NULL;
