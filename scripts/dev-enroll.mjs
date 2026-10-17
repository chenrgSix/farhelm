import https from 'node:https';
import {readFileSync} from 'node:fs';
const base=new URL(process.env.FLEET_WEB_URL ?? process.env.FLEET_SERVER_URL),ca=readFileSync(process.env.FLEET_CA_CERT);
async function call(path,body,token){return new Promise((resolve,reject)=>{const bytes=body?Buffer.from(JSON.stringify(body)):null;const req=https.request({hostname:base.hostname,port:base.port,path,method:body?'POST':'GET',ca,headers:{...(bytes?{'content-type':'application/json','content-length':String(bytes.length)}:{}),...(token?{authorization:`Bearer ${token}`}:{})}},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>{let value;try{value=JSON.parse(Buffer.concat(chunks).toString())}catch{reject(Error('Non-JSON response'));return}if(res.statusCode>=400)reject(Error(`${res.statusCode}: ${JSON.stringify(value)}`));else resolve(value)})});req.on('error',reject);if(bytes)req.write(bytes);req.end()})}
let online=false;for(let n=0;n<60;n++){try{await call('/healthz');online=true;break}catch{await new Promise(r=>setTimeout(r,250))}}
if(!online)throw Error('Local HTTPS server did not start');
const login=await call('/api/v1/login',{username:process.env.FLEET_ADMIN_USER,password:process.env.FLEET_ADMIN_PASSWORD});
const enrolled=await call('/api/v1/enrollment-tokens',{v:1,name:'Local demo',ttl_seconds:600},login.access_token);
process.stdout.write(enrolled.enrollment_token);
