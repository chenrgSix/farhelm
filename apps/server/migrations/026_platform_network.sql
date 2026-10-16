CREATE TABLE IF NOT EXISTS platform_network_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  revision INTEGER NOT NULL,
  settings_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS device_network_addresses (
  device_id TEXT PRIMARY KEY REFERENCES devices(id),
  revision INTEGER NOT NULL,
  vpn_ip TEXT,
  ssh_port INTEGER,
  updated_at INTEGER NOT NULL
);
-- Keep legacy policies until an administrator explicitly saves the global settings.
-- Import only the machine's SSH address, never the platform's Agent destination IP.
INSERT OR IGNORE INTO device_network_addresses(device_id,revision,vpn_ip,ssh_port,updated_at)
SELECT device_id,1,json_extract(config_json,'$.ssh.vpn_host'),json_extract(config_json,'$.ssh.vpn_port'),updated_at
FROM device_network_routes
WHERE json_extract(config_json,'$.ssh.vpn_host') IS NOT NULL
AND NOT EXISTS(SELECT 1 FROM meta WHERE key='platform_network_addresses_v1');
INSERT OR IGNORE INTO meta(key,value) VALUES('platform_network_addresses_v1','1');
