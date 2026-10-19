-- Installation-specific HTTPS entry; NULL keeps following the global address.
ALTER TABLE devices ADD COLUMN agent_server_url TEXT;
