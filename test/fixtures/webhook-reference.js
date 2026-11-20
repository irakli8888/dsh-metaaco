// Evaluator calibration oracle. Never include in a model prompt or training Bank.
export const webhookReferenceFiles = {
  'signature.cjs': `const {createHmac}=require('node:crypto');
exports.sign=(secret,body)=>createHmac('sha256',secret).update(body).digest('hex');
`,
  'worker.cjs': `const {sign}=require('./signature.cjs');
exports.runOnce=async({store,sender,clock,secret})=>{
 const now=clock(),job=store.claim(now);if(!job)return false;
 let ok=false;
 try{const response=await sender({url:job.url,body:job.body,headers:{'content-type':'application/json','x-signature-sha256':sign(secret,job.body)}});ok=response.status>=200&&response.status<300}catch{}
 store.settle(job.eventId,job.subscriptionId,ok,now);return true;
};
`,
  'store.cjs': `const clone=value=>structuredClone(value);
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
exports.createStore=({maxAttempts=3,retryDelayMs=100}={})=>{
 const subscriptions=new Map(),events=new Map(),keys=new Map();
 const publicEvent=record=>({id:record.id,topic:record.topic,payload:clone(record.payload),deliveries:record.deliveries.map(({claimed,...delivery})=>clone(delivery))});
 return{
  addSubscription(input){if(subscriptions.has(input.id))return false;subscriptions.set(input.id,clone(input));return true},
  enqueue(key,input){
   const fingerprint=JSON.stringify(canonical(input));
   if(keys.has(key)){const previous=keys.get(key);return previous.fingerprint===fingerprint?{kind:'duplicate',event:publicEvent(events.get(previous.id))}:{kind:'conflict',event:null}}
   if(events.has(input.id))return{kind:'conflict',event:null};
   const record={...clone(input),deliveries:[...subscriptions.values()].filter(s=>s.topic===input.topic).map(s=>({subscriptionId:s.id,url:s.url,status:'pending',attempts:0,nextAttemptAt:0,claimed:false}))};
   events.set(input.id,record);keys.set(key,{id:input.id,fingerprint});return{kind:'created',event:publicEvent(record)};
  },
  getEvent(id){return events.has(id)?publicEvent(events.get(id)):null},
  claim(now){for(const event of events.values())for(const delivery of event.deliveries){if(delivery.status!=='pending'||delivery.claimed||delivery.nextAttemptAt>now)continue;
   delivery.claimed=true;delivery.attempts++;return{eventId:event.id,subscriptionId:delivery.subscriptionId,url:delivery.url,body:JSON.stringify({id:event.id,topic:event.topic,payload:event.payload})}}
   return null;
  },
  settle(eventId,subscriptionId,ok,now){const delivery=events.get(eventId).deliveries.find(d=>d.subscriptionId===subscriptionId);delivery.claimed=false;
   if(ok)delivery.status='delivered';else if(delivery.attempts>=maxAttempts)delivery.status='failed';else delivery.nextAttemptAt=now+retryDelayMs;
  }
 };
};
`,
  'app.cjs': `exports.version=()=>1;
exports.createApi=({store})=>({handle({method,path,headers={},body}){
 const response=(status,body)=>({status,body});
 const name=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,64}$/.test(value);
 if(method==='GET'&&path==='/health')return response(200,{ok:true,version:1});
 if(method==='POST'&&path==='/subscriptions'){
  if(!body||!name(body.id)||!name(body.topic)||typeof body.url!=='string')return response(400,{error:'invalid'});
  try{const url=new URL(body.url);if(!['http:','https:'].includes(url.protocol))throw Error('scheme')}catch{return response(400,{error:'url'})}
  return store.addSubscription(body)?response(201,{id:body.id}):response(409,{error:'duplicate'});
 }
 if(method==='POST'&&path==='/events'){
  const key=Object.entries(headers??{}).find(([key])=>key.toLowerCase()==='idempotency-key')?.[1];
  if(typeof key!=='string'||!key.trim()||key.length>128||!body||!name(body.id)||!name(body.topic)||!body.payload||typeof body.payload!=='object'||Array.isArray(body.payload))return response(400,{error:'invalid'});
  const result=store.enqueue(key,{id:body.id,topic:body.topic,payload:body.payload});return result.kind==='conflict'?response(409,{error:'conflict'}):response(202,result.event);
 }
 if(method==='GET'&&path.startsWith('/events/')){const event=store.getEvent(path.slice(8));return event?response(200,event):response(404,{error:'not_found'})}
 return response(404,{error:'not_found'});
}});
`,
}
