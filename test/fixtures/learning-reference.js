// Calibration only. Never imported by a model runtime or task factory.
const jsonValidation=`const jsonSafe=(v,seen=new Set())=>{if(v===null||typeof v==='string'||typeof v==='boolean')return true;if(typeof v==='number')return Number.isFinite(v);if(typeof v!=='object'||seen.has(v))return false;if(!Array.isArray(v)&&![Object.prototype,null].includes(Object.getPrototypeOf(v)))return false;seen.add(v);const ok=Object.values(v).every(x=>jsonSafe(x,seen));seen.delete(v);return ok};`
const queue=`
${jsonValidation}
exports.version=()=>1;
exports.createQueue=({clock=Date.now,leaseMs=100,maxAttempts=2}={})=>{
 if(!Number.isInteger(leaseMs)||leaseMs<=0||!Number.isInteger(maxAttempts)||maxAttempts<=0)throw RangeError();
 const jobs=new Map();let serial=0;
 const id=x=>{if(typeof x!=='string'||!x.trim())throw TypeError()};
 const settle=(key,token,done)=>{const j=jobs.get(key);if(!j||j.status!=='leased'||j.token!==token||clock()>=j.leaseUntil)return false;j.status=done?'done':j.attempts>=maxAttempts?'failed':'pending';j.token=null;j.leaseUntil=0;return true};
 return {enqueue(key,payload){id(key);if(!payload||typeof payload!=='object'||Array.isArray(payload)||!jsonSafe(payload))throw TypeError();if(jobs.has(key))return false;jobs.set(key,{id:key,payload:structuredClone(payload),status:'pending',attempts:0,leaseUntil:0,token:null});return true},
 get:key=>jobs.has(key)?structuredClone(jobs.get(key)):null,
 claim(worker){id(worker);const now=clock();for(const j of jobs.values()){if(j.status==='leased'&&now>=j.leaseUntil)j.status=j.attempts>=maxAttempts?'failed':'pending';if(j.status!=='pending')continue;j.status='leased';j.attempts++;j.token=String(++serial);j.leaseUntil=now+leaseMs;return structuredClone(j)}return null},
 ack:(key,token)=>settle(key,token,true),fail:(key,token)=>settle(key,token,false)}
};`
const ledger=`
exports.version=()=>1;exports.createLedger=()=>{
 const balances=new Map(),accepted=new Map();const id=x=>{if(typeof x!=='string'||!x.trim())throw TypeError()};const amount=(x,min)=>{if(!Number.isSafeInteger(x)||x<min)throw RangeError()};
 return {create(key,value){id(key);amount(value,0);if(balances.has(key))return false;balances.set(key,value);return true},balance:key=>balances.has(key)?balances.get(key):null,entries:()=>structuredClone([...accepted.values()]),
 transfer(key,from,to,value){id(key);id(from);id(to);amount(value,1);const old=accepted.get(key);if(old)return old.from===from&&old.to===to&&old.amount===value?{ok:true}:{ok:false,reason:'conflict'};
 const fail=reason=>({ok:false,reason});if(!balances.has(from)||!balances.has(to))return fail('unknown');if(from===to)return fail('same-account');if(balances.get(from)<value)return fail('funds');if(!Number.isSafeInteger(balances.get(to)+value))return fail('overflow');
 balances.set(from,balances.get(from)-value);balances.set(to,balances.get(to)+value);accepted.set(key,{id:key,from,to,amount:value});return {ok:true}}
 }
};`
const cache=`
${jsonValidation}
exports.version=()=>1;exports.createCache=({clock=Date.now,capacity=2}={})=>{
 if(!Number.isInteger(capacity)||capacity<=0)throw RangeError();const ready=new Map(),pending=new Map(),versions=new Map();
 const key=k=>{if(typeof k!=='string'||!k.trim())throw TypeError()};const ttl=t=>{if(!Number.isFinite(t)||t<=0)throw RangeError()};
 const value=v=>{if(!jsonSafe(v))throw TypeError();return structuredClone(v)};
 const invalidate=k=>{versions.set(k,(versions.get(k)||0)+1);pending.delete(k)};
 const put=(k,v,t)=>{ready.delete(k);ready.set(k,{value:value(v),expires:clock()+t});while(ready.size>capacity)ready.delete(ready.keys().next().value)};
 const get=k=>{key(k);const e=ready.get(k);if(!e)return {hit:false};if(clock()>=e.expires){ready.delete(k);return {hit:false}}ready.delete(k);ready.set(k,e);return {hit:true,value:value(e.value)}};
 return {get,set(k,v,t){key(k);ttl(t);const copy=value(v);invalidate(k);put(k,copy,t);return true},delete(k){key(k);const exists=!!ready.get(k)&&clock()<ready.get(k).expires;ready.delete(k);invalidate(k);return exists},
 async getOrLoad(k,loader,t){key(k);ttl(t);if(typeof loader!=='function')throw TypeError();const hit=get(k);if(hit.hit)return hit.value;
 let work=pending.get(k);if(!work){const generation=versions.get(k)||0;work=Promise.resolve().then(loader).then(v=>{const copy=value(v);if(generation===(versions.get(k)||0))put(k,copy,t);return copy}).finally(()=>{if(pending.get(k)===work)pending.delete(k)});pending.set(k,work)}return value(await work)} }
};`
export const learningReferenceFiles={'lease-queue-train-v1':queue,'wallet-ledger-train-v1':ledger,'ttl-cache-train-v1':cache}
