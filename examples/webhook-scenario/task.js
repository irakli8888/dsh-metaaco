export const userBrief = 'Extend this webhook service with subscriptions and event ingestion. Support idempotent requests, signed delivery, retries after failures and concurrent workers without duplicate in-flight sends. Preserve existing behavior and follow the public API specification in README.md. Choose the internal architecture yourself.'

export const contracts = {
  service: 'app.cjs exports version() and createApi(options={}). The returned service has handle({method,path,headers={},body}) returning {status,body}, and async runOnce() returning true if a delivery was attempted or false if none was available. options accepts sender, clock, secret, maxAttempts=3 and retryDelayMs=100. sender({url,body,headers}) returns a Promise of {status}; clock() returns numeric time in milliseconds. Internal modules, data structures and synchronization are implementation choices.',
}

export const requirements = [
  'The service is CommonJS and runs in one process with in-memory state. Existing version()=1 and GET /health returning {status:200,body:{ok:true,version:1}} must stay compatible. Unknown routes return 404. No external dependencies or real network are required.',
  'POST /subscriptions accepts {id,topic,url}. id/topic match /^[a-zA-Z0-9_-]{1,64}$/. URL must be absolute HTTP or HTTPS. Return 201 with {id} on creation, 409 for duplicate id and 400 for invalid input.',
  'POST /events requires a case-insensitive Idempotency-Key header, a nonblank string of at most 128 characters. Body is {id,topic,payload}; id/topic follow the same pattern and payload is a JSON object. Return 202 with the event. Repeating a key with equivalent JSON returns the same event without extra deliveries, including reordered nested keys. Different content under the same key or an event id under another key returns 409. Invalid input returns 400.',
  'GET /events/:id returns 200 with an isolated event snapshot or 404. Event fields are id,topic,payload,deliveries. Each delivery exposes subscriptionId,url,status,attempts,nextAttemptAt. Capture matching subscriptions when accepting an event; later subscriptions do not change it. Initial delivery values are pending,0,0. Inputs and returned snapshots must not expose shared mutable state.',
  'runOnce attempts at most one due pending delivery. Concurrent calls must not send the same delivery simultaneously; independent recipients can progress separately. Delivered or permanently failed deliveries are not sent again. No persistence across process crashes or exactly-once effects at a remote receiver is required.',
  'The sent body is exactly JSON.stringify({id,topic,payload}). Headers are content-type=application/json and x-signature-sha256=lowercase hex HMAC-SHA256 of those exact bytes with the configured secret. Treat HTTP 200–299 as successful delivery.',
  'An exception or non-2xx response counts as a failed attempt. Increment attempts for each attempted send. Retry only when clock reaches the attempted send time plus retryDelayMs, default 100. After maxAttempts, default 3, expose failed; a success exposes delivered. Use the injected clock without waiting for real time in tests.',
]

export const specification = [
  '# Webhook service public specification',
  '',
  contracts.service,
  '',
  ...requirements.map((requirement,index)=>`${index+1}. ${requirement}`),
  '',
  'The external service entry point is fixed for compatibility. You may introduce any internal modules or keep the implementation in app.cjs. Preserve the existing project files in the final snapshot.',
].join('\n')

export const baseSnapshot = {revision:'webhook-base-v2',files:{
  'app.cjs': `exports.version=()=>1;\nexports.createApi=()=>({handle:({method,path})=>method==='GET'&&path==='/health'?{status:200,body:{ok:true,version:1}}:{status:404,body:{error:'not_found'}},runOnce:async()=>false});\n`,
  'README.md':specification,
}}


/** Explicit new public wording, without changing historical v2 exports. */
export function webhookTask(version=2){
  if(![2,3].includes(version))throw Error('Unsupported webhook scenario version')
  if(version===2)return structuredClone({userBrief,contracts,requirements,baseSnapshot})
  const service=contracts.service.replace('createApi(options={}). The returned service has handle',
    'createApi(options={}) synchronously. The returned service has synchronous handle').replace('returning {status,body},',
    'which must synchronously return an ordinary {status,body} object, never a Promise or thenable,')
  const v3Requirements=[requirements[0]+' createApi and handle are synchronous; only runOnce and the injected sender are asynchronous.',...requirements.slice(1)]
  const readme=specification.replace(contracts.service,service).replace('1. '+requirements[0],'1. '+v3Requirements[0])
  return {userBrief,contracts:{service},requirements:v3Requirements,
    baseSnapshot:{revision:'webhook-base-v3',files:{...baseSnapshot.files,'README.md':readme}}}
}
