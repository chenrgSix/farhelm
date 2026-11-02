-- Delegate configuration only through explicit role grants; preserve existing administrators.
UPDATE access_roles SET permissions=json_insert(permissions,'$[#]','scripts.manage'), revision=revision+1
WHERE id='admin' AND builtin=1 AND NOT EXISTS (SELECT 1 FROM json_each(permissions) WHERE value='scripts.manage');
