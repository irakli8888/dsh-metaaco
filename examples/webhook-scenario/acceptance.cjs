const {test}=require('node:test')
const assert=require('node:assert/strict')
const {createHmac}=require('node:crypto')
const {createApi}=require('./app.cjs')
function setup(options={}){
 let now=0,send=async()=>({status:200})
 const api=createApi({...options,clock:()=>now,secret:'secret',sender:request=>send(request)})
 return{api,setTime:value=>{now=value},setSender:value=>{send=value}}
}
const subscription=(id='s',topic='order',url='https://receiver.test/hook')=>({id,topic,url})
const event=(id='e')=>({id,topic:'order',payload:{n:1}})
function subscribe(api,input=subscription()){
 const response=api.handle({method:'POST',path:'/subscriptions',body:input})
 assert.equal(response.status,201)
 return response
}
function enqueue(api,body=event(),key='k'){
 return api.handle({method:'POST',path:'/events',headers:{'Idempotency-Key':key},body})
}
function read(api,id='e'){
 const response=api.handle({method:'GET',path:'/events/'+id})
 assert.equal(response.status,200)
 return response.body
}
function seed(options){const f=setup(options);subscribe(f.api);assert.equal(enqueue(f.api).status,202);return f}

test('subscription validation and duplicate id',()=>{
 const {api}=setup();subscribe(api)
 assert.equal(api.handle({method:'POST',path:'/subscriptions',body:subscription()}).status,409)
 for(const body of [subscription('bad id'),subscription('x','bad topic'),subscription('x','order','file:///tmp/x'),subscription('x','order','not-url'),null])
  assert.equal(api.handle({method:'POST',path:'/subscriptions',body}).status,400)
})
test('event validation and case insensitive key',()=>{
 const {api}=setup()
 assert.equal(enqueue(api).status,202)
 assert.equal(api.handle({method:'POST',path:'/events',headers:{'idempotency-key':'next'},body:event('next')}).status,202)
 for(const request of [{body:event(),headers:{}},{body:event(),headers:{'idempotency-key':''}},{body:event(),headers:{'idempotency-key':'x'.repeat(129)}},{body:{...event(),id:'bad id'},headers:{'idempotency-key':'a'}},{body:{...event(),payload:[]},headers:{'idempotency-key':'a'}}])
  assert.equal(api.handle({method:'POST',path:'/events',...request}).status,400)
})
test('idempotent enqueue accepts reordered object keys',()=>{
 const {api}=setup();subscribe(api)
 assert.equal(enqueue(api,{id:'e',topic:'order',payload:{a:1,b:{x:2,y:3}}}).status,202)
 const again=enqueue(api,{payload:{b:{y:3,x:2},a:1},topic:'order',id:'e'})
 assert.equal(again.status,202)
 assert.equal(again.body.deliveries.length,1)
 assert.equal(read(api).deliveries.length,1)
})
test('key conflict and event id conflict',()=>{
 const {api}=seed()
 assert.equal(enqueue(api,{...event(),payload:{n:2}}).status,409)
 assert.equal(enqueue(api,event(),'different-key').status,409)
})
test('fanout captures matching subscriptions at enqueue',()=>{
 const {api}=setup();subscribe(api,subscription('a'));subscribe(api,subscription('b'));subscribe(api,subscription('other','other'))
 const result=enqueue(api);assert.equal(result.status,202)
 subscribe(api,subscription('later'))
 assert.deepEqual(read(api).deliveries.map(d=>d.subscriptionId).sort(),['a','b'])
 assert.ok(result.body.deliveries.every(d=>d.status==='pending'&&d.attempts===0&&d.nextAttemptAt===0))
})
test('request and returned state are isolated',()=>{
 const {api}=setup();subscribe(api)
 const input=event(),before=structuredClone(input),result=enqueue(api,input)
 assert.equal(result.status,202);assert.deepEqual(input,before)
 input.payload.n=99;result.body.payload.n=88;result.body.deliveries.length=0
 assert.equal(read(api).payload.n,1);assert.equal(read(api).deliveries.length,1)
 const response=read(api);response.payload.n=77
 assert.equal(read(api).payload.n,1)
 assert.equal(api.handle({method:'GET',path:'/events/missing'}).status,404)
})
test('signature hashes exact wire bytes',async()=>{
 const f=setup();subscribe(f.api)
 const input={id:'e',topic:'order',payload:{message:'Привет'}}
 assert.equal(enqueue(f.api,input).status,202)
 let sent
 f.setSender(async request=>{sent=request;return{status:200}})
 assert.equal(await f.api.runOnce(),true)
 assert.equal(sent.body,JSON.stringify(input))
 assert.equal(sent.headers['x-signature-sha256'],createHmac('sha256','secret').update(sent.body).digest('hex'))
})
test('worker delivers signed event once',async()=>{
 const f=seed(),sent=[]
 f.setSender(async request=>{sent.push(request);return{status:204}})
 assert.equal(await f.api.runOnce(),true);assert.equal(await f.api.runOnce(),false)
 assert.equal(sent.length,1);assert.equal(sent[0].url,'https://receiver.test/hook')
 assert.equal(sent[0].body,JSON.stringify(event()))
 assert.equal(sent[0].headers['content-type'],'application/json')
 assert.equal(sent[0].headers['x-signature-sha256'],createHmac('sha256','secret').update(sent[0].body).digest('hex'))
 assert.equal(read(f.api).deliveries[0].status,'delivered');assert.equal(read(f.api).deliveries[0].attempts,1)
})
test('exception schedules retry and respects injected clock',async()=>{
 const f=seed(),sent=[]
 f.setSender(async request=>{sent.push(request);if(sent.length===1)throw Error('temporary');return{status:200}})
 assert.equal(await f.api.runOnce(),true);assert.equal(read(f.api).deliveries[0].nextAttemptAt,100)
 f.setTime(99);assert.equal(await f.api.runOnce(),false)
 f.setTime(100);assert.equal(await f.api.runOnce(),true)
 assert.equal(read(f.api).deliveries[0].status,'delivered');assert.equal(read(f.api).deliveries[0].attempts,2)
})
test('non 2xx exhausts attempt limit',async()=>{
 const f=seed({maxAttempts:3,retryDelayMs:100});let calls=0
 f.setSender(async()=>{calls++;return{status:500}})
 for(const now of [0,100,200]){f.setTime(now);assert.equal(await f.api.runOnce(),true)}
 assert.equal(read(f.api).deliveries[0].status,'failed');assert.equal(read(f.api).deliveries[0].attempts,3)
 f.setTime(1000);assert.equal(await f.api.runOnce(),false);assert.equal(calls,3)
})
test('concurrent workers cannot send same delivery',async()=>{
 const f=seed();let release,calls=0
 const pending=new Promise(resolve=>{release=resolve})
 f.setSender(async()=>{calls++;await pending;return{status:200}})
 const first=f.api.runOnce();await Promise.resolve();const second=f.api.runOnce()
 try{assert.equal(calls,1)}finally{release()}
 assert.equal(await second,false);assert.equal(await first,true);assert.equal(calls,1)
})
test('recipient failures do not block others',async()=>{
 const f=setup();subscribe(f.api,subscription('a','order','https://a.test'));subscribe(f.api,subscription('b','order','https://b.test'))
 assert.equal(enqueue(f.api).status,202)
 const counts={a:0,b:0}
 f.setSender(async({url})=>{const key=url.includes('a.test')?'a':'b';counts[key]++;return{status:key==='a'&&counts.a===1?500:200}})
 assert.equal(await f.api.runOnce(),true);assert.equal(await f.api.runOnce(),true)
 f.setTime(100);assert.equal(await f.api.runOnce(),true)
 assert.ok(read(f.api).deliveries.every(d=>d.status==='delivered'));assert.deepEqual(counts,{a:2,b:1})
})
