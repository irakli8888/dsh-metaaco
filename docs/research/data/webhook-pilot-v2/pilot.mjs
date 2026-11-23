import {parseArgs} from 'node:util'
import {readFile,writeFile,mkdir,appendFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {webhookScenario} from './examples/webhook-scenario/index.js'
import {prepareScenarioJob,planScenarioJob,runScenarioTrial} from './src/experiments/scenario-study.js'
import {StrategyBank} from './src/bank/index.js'
const {values}=parseArgs({options:{execute:{type:'boolean',default:false},out:{type:'string'},'budget-microunits':{type:'string'}}})
const budget=Number(values['budget-microunits'])
if(!values.out||!Number.isSafeInteger(budget)||budget<=0||budget>2000000)throw Error('Requires exclusive --out and authorized --budget-microunits <= 2000000')
const hash=value=>createHash('sha256').update(value).digest('hex')
const archiveSha256=hash(await readFile('source.tar'))
if(archiveSha256!=='29a554d4371e5e18ce43aaf1d8cf135563ead30f02764a75f54ad94cd5133f6e')throw Error('Unexpected source archive')
const scenario=await webhookScenario()
const image='sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5'
const protocol={schemaVersion:2,id:'webhook-infrastructure-pilot-v2',sourceCommit:'fbea6c9cf14ecd71e8afbd485101a33a9a6cfd54',archiveSha256,
  driverSha256:hash(await readFile(new URL(import.meta.url))),methods:['direct-flash','direct-pro','fixed','components','metaaco'],seed:7,
  budgetMicrounits:budget,evaluationDockerImage:image,taskHashes:scenario.hashes,node:process.version,
  python:execFileSync('python3',['--version'],{encoding:'utf8'}).trim(),startedAt:new Date().toISOString(),
  purpose:'Infrastructure retest, not training or statistical comparison',history:'Empty isolated bank for each method; no feedback between methods',
  rules:['One attempt per method, no paid retries','Identical public tests and limits; explicit uncalibrated priors',
    'MetaACO uses feasible initialization within 100 total evaluations','Shared remaining monetary budget changes per-attempt policy and may change available models',
    'Held costs carry forward; missing accounting stops remaining series','Direct correctness and TDD compliance are reported separately',
    'Preflight plans use total budget; actual manifests record remaining-budget plans; no manual route substitution']}
await mkdir(values.out,{mode:0o700})
const save=(path,value)=>writeFile(values.out+'/'+path,JSON.stringify(value,null,2)+'\n',{mode:0o600})
await save('protocol.json',protocol)
const preflight=[]
for(const method of protocol.methods){
  const job=prepareScenarioJob(scenario,{method,seed:protocol.seed});job.policy.maxCostMicrounits=budget
  try{preflight.push({method,job,planned:await planScenarioJob(job)})}catch(error){preflight.push({method,error:error.message})}
}
await save('preflight.json',preflight)
console.log(JSON.stringify({preflight:preflight.map(row=>({method:row.method,error:row.error??null,tasks:row.planned?.plan.tasks.map(t=>({id:t.id,model:t.model}))})),paidCalls:0},null,2))
if(!values.execute)process.exit(0)
const key=(await readFile('/home/irakli/.config/dsh-metaaco/deepseek.key','utf8')).trim()
const controller=new AbortController()
for(const event of ['SIGINT','SIGTERM'])process.once(event,()=>controller.abort(new Error('Interrupted by operator')))
let spent=0,held=0,unknown=false
const rows=[]
const checkpoint=()=>save('summary.json',{schemaVersion:2,protocol,rows,spentMicrounits:spent,heldMicrounits:unknown?null:held,
  remainingMicrounits:unknown?null:budget-spent-held,accountingComplete:!unknown&&held===0,finished:rows.length===protocol.methods.length})
await checkpoint()
for(const method of protocol.methods){
  const remaining=budget-spent-held
  if(remaining<=0||unknown||controller.signal.aborted)break
  const job=prepareScenarioJob(scenario,{method,seed:protocol.seed});job.policy.maxCostMicrounits=remaining
  job.provenance={sourceCommit:protocol.sourceCommit,archiveSha256,driverSha256:protocol.driverSha256,protocolId:protocol.id}
  const startedAt=new Date().toISOString(),start=performance.now()
  await appendFile(values.out+'/journal.jsonl',JSON.stringify({kind:'start',method,startedAt,remainingMicrounits:remaining})+'\n',{mode:0o600})
  console.log('START '+method)
  let report,error
  try{report=await runScenarioTrial({job,out:values.out+'/'+method,evaluationDockerImage:image,key,allowLlm:true,signal:controller.signal})}
  catch(caught){error=caught.message;unknown=true}
  const accounting=report?.accounting
  if(!accounting||!Number.isSafeInteger(accounting.spentMicrounits)||!Number.isSafeInteger(accounting.heldMicrounits))unknown=true
  else{spent+=accounting.spentMicrounits;held+=accounting.heldMicrounits}
  if(report?.attempt){
    const bank=new StrategyBank({dataDir:values.out+'/'+method+'/bank'})
    try{await writeFile(values.out+'/'+method+'/bank-export.jsonl',bank.exportJsonl(),{flag:'wx',mode:0o600})}finally{bank.close()}
  }
  rows.push({method,startedAt,finishedAt:new Date().toISOString(),driverWallTimeMs:performance.now()-start,state:report?.state??'failed',
    attemptCreated:!!report?.attempt,acceptancePassed:report?.acceptancePassed??false,
    correctness:report?.attempt?.evaluation?.correctness??null,tddCompliance:report?.attempt?.evaluation?.tddCompliance??null,
    accounting:accounting??null,error:report?.error??(error?{message:error}:null)})
  await appendFile(values.out+'/journal.jsonl',JSON.stringify({kind:'finish',...rows.at(-1)})+'\n',{mode:0o600})
  await checkpoint()
  console.log('DONE '+method+' '+rows.at(-1).state+' accepted='+rows.at(-1).acceptancePassed+' knownCost='+spent+' held='+held)
}
await checkpoint()
console.log('PILOT_FINISHED knownCost='+spent+' unknown='+unknown)
