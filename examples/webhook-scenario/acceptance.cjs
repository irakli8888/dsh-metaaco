const {test}=require('node:test')
const assert=require('node:assert/strict')
const {createHmac}=require('node:crypto')
const {createApi}=require('./app.cjs')
const {createStore}=require('./store.cjs')
const {runOnce}=require('./worker.cjs')
const {sign}=require('./signature.cjs')
function setup(options){const store=createStore(options);return{store,api:createApi({store})}}
const subscription=(id='s',topic='order',url='https://receiver.test/hook')=>({id,topic,url})
const event=(id='e')=>({id,topic:'order',payload:{n:1}})
function enqueue(api,body=event(),key='k'){
 return api.handle({method:'POST',path:'/events',headers:{'Idempotency-Key':key},body})
}
function seed(options){const f=setup(options);assert.equal(f.store.addSubscription(subscription()),true);assert.equal(enqueue(f.api).status,202);return f}

test('subscription validation and duplicate id',()=>{
 const {api}=setup()
 assert.equal(api.handle({method:'POST',path:'/subscriptions',body:subscription()}).status,201)
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
 const {api,store}=setup();assert.equal(store.addSubscription(subscription()),true)
 assert.equal(enqueue(api,{id:'e',topic:'order',payload:{a:1,b:{x:2,y:3}}}).status,202)
 const again=enqueue(api,{payload:{b:{y:3,x:2},a:1},topic:'order',id:'e'})
 assert.equal(again.status,202)
 assert.equal(again.body.deliveries.length,1)
 assert.equal(store.getEvent('e').deliveries.length,1)
})
test('key conflict and event id conflict',()=>{
 const {api}=seed()
 assert.equal(enqueue(api,{...event(),payload:{n:2}}).status,409)
 assert.equal(enqueue(api,event(),'different-key').status,409)
})
test('fanout captures matching subscriptions at enqueue',()=>{
 const {api,store}=setup()
 assert.equal(store.addSubscription(subscription('a')),true)
 assert.equal(store.addSubscription(subscription('b')),true)
 assert.equal(store.addSubscription(subscription('other','other')),true)
 const result=enqueue(api)
 assert.equal(result.status,202)
 store.addSubscription(subscription('later'))
 assert.deepEqual(store.getEvent('e').deliveries.map(d=>d.subscriptionId).sort(),['a','b'])
 assert.ok(result.body.deliveries.every(d=>d.status==='pending'&&d.attempts===0&&d.nextAttemptAt===0))
})
test('request and returned state are isolated',()=>{
 const {api,store}=setup()
 assert.equal(store.addSubscription(subscription()),true)
 const input=event(),before=structuredClone(input),result=enqueue(api,input)
 assert.equal(result.status,202)
 assert.deepEqual(input,before)
 input.payload.n=99;result.body.payload.n=88;result.body.deliveries.length=0
 assert.equal(store.getEvent('e').payload.n,1)
 assert.equal(store.getEvent('e').deliveries.length,1)
 const response=api.handle({method:'GET',path:'/events/e'})
 assert.equal(response.status,200)
 response.body.payload.n=77
 assert.equal(store.getEvent('e').payload.n,1)
 assert.equal(api.handle({method:'GET',path:'/events/missing'}).status,404)
})
test('signature hashes exact wire bytes',()=>{
 const body='{"message":"Привет"}'
 assert.equal(sign('secret',body),createHmac('sha256','secret').update(body).digest('hex'))
})
test('worker delivers signed event once',async()=>{
 const {store}=seed(),sent=[]
 const args={store,clock:()=>0,secret:'secret',sender:async request=>{sent.push(request);return{status:204}}}
 assert.equal(await runOnce(args),true)
 assert.equal(await runOnce(args),false)
 assert.equal(sent.length,1)
 assert.equal(sent[0].url,'https://receiver.test/hook')
 assert.equal(sent[0].body,JSON.stringify(event()))
 assert.equal(sent[0].headers['content-type'],'application/json')
 assert.equal(sent[0].headers['x-signature-sha256'],createHmac('sha256','secret').update(sent[0].body).digest('hex'))
 assert.equal(store.getEvent('e').deliveries[0].status,'delivered')
 assert.equal(store.getEvent('e').deliveries[0].attempts,1)
})
test('exception schedules retry and respects injected clock',async()=>{
 const {store}=seed(),sent=[];let now=0
 const args={store,clock:()=>now,secret:'secret',sender:async request=>{sent.push(request);if(sent.length===1)throw Error('temporary');return{status:200}}}
 assert.equal(await runOnce(args),true)
 assert.equal(store.getEvent('e').deliveries[0].nextAttemptAt,100)
 now=99;assert.equal(await runOnce(args),false)
 now=100;assert.equal(await runOnce(args),true)
 assert.equal(store.getEvent('e').deliveries[0].status,'delivered')
 assert.equal(store.getEvent('e').deliveries[0].attempts,2)
})
test('non 2xx exhausts attempt limit',async()=>{
 const {store}=seed({maxAttempts:3,retryDelayMs:100});let now=0,calls=0
 const args={store,clock:()=>now,secret:'s',sender:async()=>{calls++;return{status:500}}}
 for(now=0;now<=200;now+=100)assert.equal(await runOnce(args),true)
 assert.equal(store.getEvent('e').deliveries[0].status,'failed')
 assert.equal(store.getEvent('e').deliveries[0].attempts,3)
 now=1000;assert.equal(await runOnce(args),false);assert.equal(calls,3)
})
test('concurrent workers cannot claim same delivery',async()=>{
 const {store}=seed();let release,calls=0
 const pending=new Promise(resolve=>{release=resolve})
 const args={store,clock:()=>0,secret:'s',sender:async()=>{calls++;await pending;return{status:200}}}
 const first=runOnce(args)
 await Promise.resolve()
 const second=runOnce(args)
 try{assert.equal(calls,1)}finally{release()}
 assert.equal(await second,false)
 assert.equal(await first,true)
 assert.equal(calls,1)
})
test('recipient failures do not block others',async()=>{
 const {api,store}=setup();assert.equal(store.addSubscription(subscription('a','order','https://a.test')),true)
 store.addSubscription(subscription('b','order','https://b.test'));assert.equal(enqueue(api).status,202)
 let now=0;const counts={a:0,b:0}
 const args={store,clock:()=>now,secret:'s',sender:async({url})=>{const key=url.includes('a.test')?'a':'b';counts[key]++;return{status:key==='a'&&counts.a===1?500:200}}}
 assert.equal(await runOnce(args),true);assert.equal(await runOnce(args),true)
 now=100;assert.equal(await runOnce(args),true)
 assert.ok(store.getEvent('e').deliveries.every(d=>d.status==='delivered'))
 assert.deepEqual(counts,{a:2,b:1})
})
