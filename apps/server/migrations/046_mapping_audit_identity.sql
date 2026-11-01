-- Keep the original audit log intact. Present pre-fix mapping client events
-- using the same identity as new ones before filtering or paginating history.
CREATE VIEW IF NOT EXISTS audit_history AS
WITH events AS NOT MATERIALIZED (
  SELECT *, actor_id IS NOT NULL AND (
    action IN ('mapping.connection_denied','mapping.forward_opened','mapping.forward_closed')
    OR (action='authorization.denied' AND COALESCE(json_extract(detail_json,'$.route'),'')='tcp-mapping')
  ) AS legacy_client FROM audit
)
SELECT id,at,actor_id,device_id,task_id,action,detail_json,actor_username,device_name,target_name,request_context
FROM events WHERE NOT legacy_client
UNION ALL
SELECT id,at,NULL,device_id,task_id,action,
       json_set(detail_json,'$.owner_id',actor_id,'$.owner_username',actor_username),
       NULL,device_name,target_name,request_context
FROM events WHERE legacy_client;
