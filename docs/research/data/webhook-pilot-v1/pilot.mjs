import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {webhookScenario} from './examples/webhook-scenario/index.js'
import {webhookReferenceFiles} from './test/fixtures/webhook-reference.js'
import {TDDEvaluator} from './src/evaluation/index.js'
import {StrategyBank} from './src/bank/index.js'
import {prepareScenarioJob,runScenarioJob} from './src/experiments/scenario-study.js'
const image='sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5'
const scenario=await webhookScenario()
const evaluator=new TDDEvaluator({spec:scenario.request.testSpec})
const results={}
for(const phase of ['baseline','red','green','refactor']){
  const snapshot=['baseline','red'].includes(phase)?scenario.baseSnapshot:{revision:'calibration',files:{...scenario.baseSnapshot.files,...webhookReferenceFiles}}
  results[phase]=await evaluator.runPhase(phase,snapshot,{dockerImage:image})
}
const failures=results.red.reports.flatMap(r=>r.tests.filter(t=>t.type==='test:fail'))
if(!results.baseline.reports.every(r=>r.status==='passed')||failures.length!==12||!failures.every(t=>t.code==='ERR_ASSERTION')||!['green','refactor'].every(p=>results[p].reports.every(r=>r.status==='passed')))throw Error('Docker calibration failed')
await writeFile('docker-calibration.json',JSON.stringify({schemaVersion:1,results,evaluation:evaluator.evaluate()},null,2),{flag:'wx',mode:0o600})
console.log('DOCKER_CALIBRATION_PASSED')
if(!process.argv.includes('--execute'))process.exit(0)
const sourceArchiveSha256=createHash('sha256').update(await readFile('source.tar')).digest('hex')
const protocol={schemaVersion:1,id:'webhook-infrastructure-pilot-v1',sourceCommit:'c02135a1c9b90b6fb420ac56c4e78672785fcac0',sourceArchiveSha256,
  methods:['direct-flash','direct-pro','fixed','components','metaaco'],seed:7,budgetMicrounits:1000000,
  image,node:process.version,startedAt:new Date().toISOString(),purpose:'Infrastructure pilot, not training or statistical method comparison',
  history:'Empty per attempt; no feedback from pilot reused',forecast:'Uncalibrated equal 10s per skill/model',
  caveats:['Pro reservation exceeds total authorized budget','Search uses conservative tariff bounds; budget can exclude routes before quality is known','Shared remaining budget can differ across methods; no comparative efficacy claim']}
await mkdir('pilot',{mode:0o700})
await writeFile('pilot/protocol.json',JSON.stringify(protocol,null,2),{flag:'wx',mode:0o600})
const key=(await readFile('/home/irakli/.config/dsh-metaaco/deepseek.key','utf8')).trim()
let spent=0,held=0
const rows=[]
const controller=new AbortController()
for(const sig of ['SIGTERM','SIGINT'])process.once(sig,()=>controller.abort(new Error('Interrupted by operator')))
for(const method of protocol.methods){
  const remaining=protocol.budgetMicrounits-spent-held
  if(remaining<=0||controller.signal.aborted)break
  const job=prepareScenarioJob(scenario,{method,seed:protocol.seed})
  job.policy.maxCostMicrounits=remaining
  job.provenance={sourceCommit:protocol.sourceCommit,sourceArchiveSha256,protocolId:protocol.id,node:process.version}
  const out='pilot/'+method
  const startedAt=new Date().toISOString()
  console.log('START '+method)
  let report,error
  try{report=await runScenarioJob({job,out,evaluationDockerImage:image,key,allowLlm:true,signal:controller.signal})}catch(e){error=e.message}
  let ledger=null
  try{
    const bank=new StrategyBank({dataDir:out+'/bank'})
    try{ledger=bank.getBudget('attempt/scenario-attempt');await writeFile(out+'/bank-export.jsonl',bank.exportJsonl(),{flag:'wx',mode:0o600})}finally{bank.close()}
  }catch(e){error??=e.message}
  if(ledger){spent+=ledger.spentMicrounits;held+=ledger.heldMicrounits}
  else {held+=remaining} // No accounting proof: reserve remaining authorization and stop.
  rows.push({method,startedAt,finishedAt:new Date().toISOString(),state:report?.attempt.state??'failed',acceptancePassed:report?.acceptancePassed??false,
    evaluation:report?.attempt.evaluation??null,spentMicrounits:ledger?.spentMicrounits??null,heldMicrounits:ledger?.heldMicrounits??null,error:error??null})
  await writeFile('pilot/summary.json',JSON.stringify({protocol,rows,spentMicrounits:spent,heldMicrounits:held,remainingMicrounits:protocol.budgetMicrounits-spent-held},null,2),{mode:0o600})
  console.log('DONE '+method+' '+rows.at(-1).state+' cost='+rows.at(-1).spentMicrounits)
}
console.log('PILOT_FINISHED')
