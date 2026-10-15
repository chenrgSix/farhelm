import json
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2] / 'contracts/v1'
BASE = 'https://fleet.local/contracts/v1/'
DRAFT = 'https://json-schema.org/draft/2020-12/schema'

def ref(path): return {'$ref': path}
def common(name): return ref('common.schema.json#/$defs/' + name)
def obj(props, required=None):
    return {'type':'object','additionalProperties':False,'properties':props,'required':list(props) if required is None else required}
def schema(name, body, description=None):
    doc={'$schema':DRAFT,'$id':BASE+name+'.schema.json','title':'Farhelm v1 '+name, **body}
    if description: doc['description']=description
    (ROOT/(name+'.schema.json')).write_text(json.dumps(doc,indent=2,ensure_ascii=False)+'\n')

def versioned(props, required=None):
    return obj({'v':{'const':1},**props}, None if required is None else ['v']+required)

def nullable(x): return {'anyOf':[x,{'type':'null'}]}

common_defs={
    'id':{'type':'string','minLength':1,'maxLength':128,'pattern':'^[^\\r\\n\\u0000\\uD800-\\uDFFF]+$'},
    'uuid':{'type':'string','format':'uuid'},
    'timestamp':{'type':'integer','minimum':0,'maximum':9007199254740991},
    'sequence':{'type':'integer','minimum':1,'maximum':9007199254740991},
    'sha256':{'type':'string','pattern':'^[0-9a-f]{64}$'},
    'public_key':{'type':'string','pattern':'^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$'},
    'signature':{'type':'string','pattern':'^[A-Za-z0-9+/]{85}[AQgw]==$'},
    'base64':{'type':'string','minLength':4,'pattern':'^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=|[A-Za-z0-9+/][AQgw]==)?$'},
    'token':{'type':'string','minLength':1,'maxLength':2048,'pattern':'^[^\\r\\n\\u0000\\uD800-\\uDFFF]+$'},
    'name':{'type':'string','minLength':1,'maxLength':128},
    'argument':{'type':'string','minLength':1,'maxLength':8192,'pattern':'^[^\\u0000\\uD800-\\uDFFF]*$'},
    'argv':{'type':'array','minItems':1,'maxItems':128,'prefixItems':[{'allOf':[common('argument'),{'type':'string','pattern':'^(?:/.*|[^/]+)$'}]}],'items':common('argument')},
    'cwd':{'type':'string','minLength':1,'maxLength':4096,'pattern':'^/[^\\u0000\\uD800-\\uDFFF]*$'},
    'timeout_ms':{'type':'integer','minimum':100,'maximum':3600000},
    'max_output_bytes':{'type':'integer','minimum':0,'maximum':1048576},
    'terminal_status':{'enum':['SUCCEEDED','FAILED','TIMED_OUT','CANCELLED','EXPIRED','UNKNOWN']},
    'task_status':{'enum':['QUEUED','SENT','ACCEPTED','RUNNING','SUCCEEDED','FAILED','TIMED_OUT','CANCELLED','EXPIRED','UNKNOWN']},
    'empty':obj({}),
    'artifact':obj({'sha256':common('sha256'),'size':{'type':'integer','minimum':0,'maximum':1048576}})
}
schema('common',{'$defs':common_defs},'Shared scalar bounds and exact structures. Limits align with the server implementation; aggregate byte limits remain runtime checks.')
task_props={
    'task_id':common('id'),'device_id':common('id'),'actor_id':common('id'),'action':{'const':'exec'},
    'argv':common('argv'),'cwd':common('cwd'),'created_at':common('timestamp'),'expires_at':common('timestamp'),
    'timeout_ms':common('timeout_ms'),'max_output_bytes':common('max_output_bytes'),'payload_hash':common('sha256')
}
schema('task',obj(task_props),'Immutable task body, not an HTTP body. Hash is SHA256 of canonical UTF-8 JSON excluding payload_hash. Time ordering, byte totals and hash equality require runtime validation.')
result_props={
    'status':common('terminal_status'),'exit_code':nullable({'type':'integer','minimum':-2147483648,'maximum':2147483647}),
    'reason':nullable({'type':'string','maxLength':4096}),'audit_complete':{'type':'boolean'},
    'stdout':{'anyOf':[common('artifact'),common('empty'),{'type':'null'}]},
    'stderr':{'anyOf':[common('artifact'),common('empty'),{'type':'null'}]},
    'started_at':nullable(common('timestamp')),'finished_at':common('timestamp'),
    'cleanup':{'enum':['process_group','unconfirmed','not_started']}
}
result=obj(result_props)
result['anyOf']=[
    {'properties':{'stdout':common('artifact'),'stderr':common('artifact')}},
    {'properties':{'status':{'const':'UNKNOWN'},'audit_complete':{'const':False},'stdout':nullable(common('artifact')),'stderr':nullable(common('artifact'))}},
    {'properties':{'status':{'enum':['FAILED','CANCELLED','EXPIRED','UNKNOWN']},'cleanup':{'const':'not_started'},'started_at':{'type':'null'}}}
]
result['allOf']=[
    {'if':{'properties':{'cleanup':{'const':'not_started'}}},'then':{'properties':{'started_at':{'type':'null'},'exit_code':{'type':'null'},'status':{'enum':['FAILED','CANCELLED','EXPIRED','UNKNOWN']}}}},
    {'if':{'properties':{'status':{'const':'UNKNOWN'}}},'then':{'properties':{'audit_complete':{'const':False}}}},
    {'if':{'properties':{'status':{'const':'EXPIRED'}}},'then':{'properties':{'cleanup':{'const':'not_started'},'started_at':{'type':'null'},'exit_code':{'type':'null'}}}}
]
schema('result',result,'Missing streams are allowed only for UNKNOWN with incomplete audit or terminal no-execution results. Empty objects are allowed only for no-execution results. Storage durability and truthful cleanup remain runtime invariants.')
event_props={'event_id':common('uuid'),'task_id':common('id'),'seq':common('sequence'),'kind':{'enum':['accepted','started','finished']},'at':common('timestamp'),'payload':{'anyOf':[common('empty'),ref('result.schema.json')]}}
event=obj(event_props)
event['allOf']=[{'if':{'properties':{'kind':{'const':'finished'}}},'then':{'properties':{'payload':ref('result.schema.json')}},'else':{'properties':{'payload':common('empty')}}}]
schema('event',event,'A single durable event body. Event sequence continuity, state transitions, replay identity and artifact availability are checked transactionally by the server.')
ack=obj({'event_id':common('uuid'),'task_id':common('id'),'seq':common('sequence')})
hello=obj({'agent_version':{'type':'string','minLength':1,'maxLength':128}})
wire_types={'agent.hello':hello,'agent.heartbeat':hello,'task.assign':ref('task.schema.json'),'task.cancel':obj({'task_id':common('id')}),'task.event':ref('event.schema.json'),'event.ack':ack,'error':obj({'code':{'type':'string','minLength':1,'maxLength':128}})}
schema('envelope',{'oneOf':[obj({'v':{'const':1},'type':{'const':t},'body':b}) for t,b in wire_types.items()]},'Only enumerated v1 WSS frames are accepted. Enforce the 65536-byte UTF-8 limit before parsing. Tokens never appear in WSS JSON or query parameters.')
schema('challenge-request',{'oneOf':[
    versioned({'purpose':{'const':'enroll'},'public_key':common('public_key'),'enrollment_token':common('token')}),
    versioned({'purpose':{'const':'auth'},'public_key':common('public_key'),'device_id':common('id')},['purpose','public_key'])
]},'Auth without device_id supports registered-key recovery. Enrollment token and auth device ID are purpose-specific; signing bytes include empty fields where omitted.')
schema('challenge-response',versioned({'challenge_id':common('id'),'signing_payload':common('base64'),'expires_at':common('timestamp')}))
schema('enrollment',versioned({'challenge_id':common('id'),'signature':common('signature'),'name':common('name')}))
schema('enrollment-response',versioned({'device_id':common('id')}))
schema('auth',versioned({'challenge_id':common('id'),'signature':common('signature')}))
schema('auth-response',versioned({'device_id':common('id'),'access_token':common('token'),'expires_at':common('timestamp')}))
schema('commands',versioned({'device_id':common('id'),'argv':common('argv'),'cwd':common('cwd'),'timeout_ms':common('timeout_ms'),'max_output_bytes':common('max_output_bytes'),'ttl_seconds':{'type':'integer','minimum':1,'maximum':86400}}),'User command request. Idempotency-Key is a required HTTP header, not a JSON field. actor_id, task_id, action, timestamps and hash are assigned by the authenticated server.')
schema('command-response',versioned({'task_id':common('id'),'status':common('task_status')}))
schema('enrollment-token-request',versioned({'name':common('name'),'ttl_seconds':{'type':'integer','minimum':60,'maximum':86400}},[]))
schema('enrollment-token-response',versioned({'enrollment_token':common('token'),'expires_at':common('timestamp')}))
schema('login',obj({'username':{'type':'string','minLength':1,'maxLength':128},'password':{'type':'string','minLength':1,'maxLength':1024}}),'Login is the sole unversioned API request/response exception.')
user_props={'id':common('id'),'username':{'type':'string','minLength':1,'maxLength':128},'role':{'enum':['admin','ops','business','auditor']},'device_scope':{'anyOf':[{'const':'*'},{'type':'array','uniqueItems':True,'items':common('id')}]}}
schema('user',obj(user_props))
schema('login-response',obj({'access_token':common('token'),'user':ref('user.schema.json')}))
schema('me-response',versioned(user_props))
device_props={'id':common('id'),'name':common('name'),'control_online':{'type':'boolean'},'private_data_reachable':{'type':'null'},'business_healthy':{'type':'null'},'last_seen':nullable(common('timestamp')),'revoked_at':nullable(common('timestamp')),'agent_version':nullable({'type':'string'})}
schema('device',obj(device_props),'Unmeasured private-data and business-health states are explicitly null in this milestone.')
schema('devices-response',versioned({'devices':{'type':'array','items':ref('device.schema.json')}}))
detail_props={**task_props,'status':common('task_status'),'last_seq':{'type':'integer','minimum':0,'maximum':9007199254740991},'cancel_requested':{'type':'boolean'},'result':nullable(ref('result.schema.json'))}
schema('task-detail',obj(detail_props))
schema('task-response',versioned(detail_props))
schema('tasks-response',versioned({'tasks':{'type':'array','items':ref('task-detail.schema.json')}}))
schema('cancel-request',versioned({}))
schema('cancel-response',versioned({'ok':{'const':True},'status':common('task_status')}))
schema('revoke-request',versioned({}))
schema('revoke-response',versioned({'ok':{'const':True}}))
schema('artifact-response',versioned({'sha256':common('sha256'),'size':{'type':'integer','minimum':0,'maximum':1048576}}),'Upload response; stored stream references omit v. Upload request and download response are raw octets, not JSON.')

schema('error-response',versioned({'error':{'type':'string','minLength':1,'maxLength':128}}),'Implementation extension: stable HTTP error code, including failed login responses.')
schema('health-response',versioned({'ok':{'const':True},'server_instance':common('id')}),'Implementation extension: readiness response from GET /healthz.')

# Exact current output variants. Adding an audit action requires deliberate contract review.
role={'enum':['admin','ops','business','auditor']}
audit_details={
    'user.bootstrap':obj({'username':{'type':'string','minLength':1,'maxLength':128},'role':role}),
    'user.login':common('empty'),
    'user.login_failed':obj({'username_hash':common('sha256')}),
    'enrollment.created':obj({'expires_at':common('timestamp'),'name':nullable(common('name'))}),
    'device.enrolled':obj({'recovered':{'type':'boolean'}}),
    'device.revoked':common('empty'),
    'task.created':obj({'action':{'const':'AGENT_EXEC'},'argv':common('argv'),'cwd':common('cwd'),'role':role,'authorized':{'const':True},'payload_hash':common('sha256')}),
    'task.cancel_requested':common('empty'),
    'output.viewed':obj({'stream':{'enum':['stdout','stderr']},'sha256':common('sha256'),'size':{'type':'integer','minimum':0,'maximum':1048576}}),
    'authorization.denied':obj({'reason':{'type':'string','minLength':1},'method':{'type':'string','minLength':1},'route':{'type':'string','minLength':1}})
}
for kind in ['accepted','started','finished']:
    audit_details['task.'+kind]=obj({'event_id':common('uuid'),'seq':common('sequence'),'at':common('timestamp'),'payload':ref('result.schema.json') if kind=='finished' else common('empty')})
audit_props={'id':{'type':'integer','minimum':1,'maximum':9007199254740991},'at':common('timestamp'),'actor_id':nullable(common('id')),'device_id':nullable(common('id')),'task_id':nullable(common('id')),'action':{'enum':list(audit_details)},'detail':{'anyOf':list(audit_details.values())}}
audit=obj(audit_props)
audit['allOf']=[{'if':{'properties':{'action':{'const':action}}},'then':{'properties':{'detail':detail}}} for action,detail in audit_details.items()]
schema('audit',audit,'Strict current server audit output variants. New actions and detail fields require explicit contract updates; storage may remain extensible.')
schema('audit-response',versioned({'audit':{'type':'array','items':ref('audit.schema.json')}}))
