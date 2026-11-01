ALTER TABLE tcp_mappings ADD COLUMN suspended_reason TEXT;

-- A device switch and all of its listener suspensions must survive a crash together.
CREATE TRIGGER suspend_device_tcp_mappings AFTER UPDATE OF enabled ON device_forwarding
WHEN NEW.enabled = 0 AND OLD.enabled = 1
BEGIN
  UPDATE tcp_mappings
  SET suspended_reason='DEVICE_FORWARDING_DISABLED', revision=revision+1, updated_at=NEW.updated_at
  WHERE device_id=NEW.device_id AND suspended_reason IS NULL AND json_extract(config_json,'$.enabled')=1;
END;

-- v0.2.17 only kept this state in memory. Recover recorded switch-offs that
-- happened after the last explicit save; independently saved mappings stay live.
UPDATE tcp_mappings AS m
SET suspended_reason='DEVICE_FORWARDING_DISABLED', revision=revision+1, updated_at=MAX(updated_at, CAST(unixepoch('subsec')*1000 AS INTEGER))
WHERE json_extract(config_json,'$.enabled')=1 AND EXISTS (
  SELECT 1 FROM audit a WHERE a.device_id=m.device_id AND a.action='device.forwarding_updated'
    AND json_extract(a.detail_json,'$.enabled')=0 AND a.id > COALESCE((
      SELECT MAX(s.id) FROM audit s WHERE s.device_id=m.device_id AND s.action IN ('mapping.created','mapping.updated')
        AND json_extract(s.detail_json,'$.mapping_id')=m.id
    ),0)
);
