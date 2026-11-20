export const contracts = {
  store: 'createStore({maxAttempts=3,retryDelayMs=100}={}) returns addSubscription({id,topic,url}):boolean, enqueue(key,{id,topic,payload}):{kind:"created"|"duplicate"|"conflict",event}, getEvent(id):event|null, claim(now):job|null, settle(eventId,subscriptionId,ok,now):void. Event has id,topic,payload,deliveries:[{subscriptionId,url,status,attempts,nextAttemptAt}]. Job has eventId,subscriptionId,url,body.',
  api: 'createApi({store}) returns handle({method,path,headers={},body}). Response is {status,body}. Existing GET /health returns {status:200,body:{ok:true,version:1}}. version() returns 1.',
  delivery: 'async runOnce({store,sender,clock,secret}) claims at most one due job, sends {url,body,headers}, settles it, returns true if claimed or false if no work. sender returns {status}; throwing or non-2xx is failure. signature.sign(secret,body) returns lowercase hex HMAC-SHA256 of exact body string.',
}

export const requirements = [
  'Extend an existing CommonJS webhook service. Keep existing exports and health endpoint. No external dependencies or network access are required; sender and clock are injected.',
  'POST /subscriptions accepts {id,topic,url}. id/topic match /^[a-zA-Z0-9_-]{1,64}$/. URL must be absolute HTTP or HTTPS. Return 201 with {id} on creation, 409 for duplicate subscription id, 400 for invalid input.',
  'POST /events requires a case-insensitive Idempotency-Key header, a nonempty string of at most 128 characters. Body is {id,topic,payload}; id/topic follow the same pattern and payload is a JSON object. Return 202 with the event object. Identical key and equivalent JSON content returns the original event without new deliveries. Reusing key with different content or event id under a different key returns 409. Invalid input returns 400.',
  'GET /events/:id returns 200 and an isolated event snapshot, or 404. Unknown routes return 404. At enqueue, capture matching subscriptions exactly once. Each delivery begins pending, attempts=0, nextAttemptAt=0. Do not mutate request bodies or leak internal mutable state through responses.',
  'Claim atomically reserves one due pending delivery before awaiting sender and increments attempts. Concurrent runOnce calls must not send the same delivery twice. Independent recipients can progress separately.',
  'Send exact JSON.stringify({id,topic,payload}) with content-type application/json and x-signature-sha256=sign(secret,body). Successful HTTP status 200–299 marks delivered. On exception or non-2xx, release the claim and schedule now+retryDelayMs; after maxAttempts mark failed. Delivered/failed jobs are never claimed again. Each runOnce uses a single clock() time for claim and settlement.',
  'This is an in-memory single-process service with asynchronous concurrent workers. Do not claim persistence across process crashes or exactly-once effects at a remote receiver. Preserve all existing files needed by the final snapshot.',
]

export const baseSnapshot = { revision:'webhook-base-v1', files:{
  'app.cjs': `exports.version=()=>1;\nexports.createApi=()=>({handle:({method,path})=>method==='GET'&&path==='/health'?{status:200,body:{ok:true,version:1}}:{status:404,body:{error:'not_found'}}});\n`,
  'store.cjs': `exports.createStore=()=>({addSubscription:()=>false,enqueue:()=>({kind:'conflict',event:null}),getEvent:()=>null,claim:()=>null,settle:()=>{}});\n`,
  'worker.cjs': `exports.runOnce=async()=>false;\n`,
  'signature.cjs': `exports.sign=()=>'';\n`,
} }

export const componentOwnership = {
  'implement-store':['store.cjs'],
  'implement-api':['app.cjs'],
  'implement-delivery':['worker.cjs','signature.cjs'],
}
