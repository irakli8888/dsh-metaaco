import {mkdir,writeFile,open} from 'node:fs/promises'
import {join,isAbsolute} from 'node:path'
import {StrategyBank} from '../bank/index.js'
import {advanceFeedback,readFeedback} from '../feedback/index.js'
import {armId,hash} from '../selector/contracts.js'
import {seededIndex} from '../selector/index.js'
import {runAdaptiveAttempt} from '../orchestration/index.js'
import {prepareScenarioJob,planScenarioJob} from './scenario-study.js'
import {createScenarioRuntime} from './scenario-runtime.js'
import {routeIdentity} from './skill-search.js'

export function buildTrainingEvidence(records,decisions,taskId){
 const stats=new Map(),observedAttemptIds=[]
 for(const r of records.filter(r=>r.taskId===taskId)){
  observedAttemptIds.push(r.attemptId)
  const d=decisions.get(r.attemptId)
  if(!d)throw Error('Sealed history has no pinned decision')
  const success=r.state==='succeeded'&&r.evaluationVerified&&r.evaluation?.status==='success'
  const failed=r.state==='failed'&&r.outcome?.measured?.coverageComplete===true
  if(!r.outcome?.measured?.coverageComplete||(!success&&!failed))continue
  const key=JSON.stringify(d.route),row=stats.get(key)??{route:d.route,attempts:0,successes:0,choices:d.choices,cost:d.costMicrounits}
  row.attempts++;if(success)row.successes++;stats.set(key,row)
 }
 const best=[...stats.values()].filter(r=>r.successes>0).sort((a,b)=>(b.successes+1)/(b.attempts+2)-(a.successes+1)/(a.attempts+2)||a.cost-b.cost||JSON.stringify(a.route).localeCompare(JSON.stringify(b.route),'en'))[0]
 return {observedAttemptIds,qualityEvidence:[...stats.values()].map(({route,attempts,successes})=>({route,attempts,successes})),warmStartChoices:best?[best.choices]:[]}
}

export function trainingIntervention(round,seed,seeds){
 if(round===0)return {requiredLayout:'monolith',requiredRoutes:seed===seeds[0]?{}:{implement:{provider:'deepseek',model:'deepseek-v4-pro'}}}
 if(round===1)return {requiredLayout:'components',requiredRoutes:{[seed===seeds[0]?'design':'integrate']:{provider:'deepseek',model:'deepseek-v4-pro'}}}
 return {requiredLayout:null,requiredRoutes:{}}
}

/** One shared transactional series ledger; seed-specific train IDs isolate feedback. */
export async function runScenarioTraining({tasks,seeds=[7,11],rounds=4,out,budgetMicrounits,evaluationDockerImage,
 key,fetchImpl,allowLlm=false,signal,provenance={},createRuntime}){
 if(allowLlm!==true)throw Error('Explicit allowLlm: true required')
 signal?.throwIfAborted()
 if(!isAbsolute(out)||!Number.isSafeInteger(budgetMicrounits)||budgetMicrounits<=0||!Number.isInteger(rounds)||rounds<1||rounds>4||
   !Array.isArray(seeds)||!seeds.length||seeds.length>2||new Set(seeds).size!==seeds.length||!tasks.length||tasks.some(t=>t.split!=='train')||new Set(tasks.map(t=>t.request.taskId)).size!==tasks.length)throw Error('Invalid training series')
 for(const seed of seeds)seededIndex(seed,'validate',1)
 const prepared=tasks.map(t=>prepareScenarioJob(t))
 if(prepared.some(j=>j.schemaVersion!==3))throw Error('Training requires typed scenario job v3')
 const reserveFloor=2*prepared[0].prices['deepseek-v4-pro'].upperBoundMicrounits
 await mkdir(out,{mode:0o700});await mkdir(join(out,'decisions'),{mode:0o700})
 const config={schemaVersion:1,id:'multitask-training-v1',tasks,seeds,rounds,budgetMicrounits,reserveFloor,evaluationDockerImage:evaluationDockerImage??null,provenance,
  learning:'Task-scoped Beta(1,1) route quality; round 0/1 stratified layout/model interventions, round 2/3 unrestricted MetaACO with observed warm seed',
  splits:{train:tasks.map(t=>t.request.taskId),validation:[],test:[]},scope:'Training only. Pilots excluded; no cross-task transfer or held-out evaluation.'}
 await writeFile(join(out,'manifest.json'),JSON.stringify({...config,configHash:hash(config),startedAt:new Date().toISOString()},null,2),{flag:'wx',mode:0o600})
 const bank=new StrategyBank({dataDir:join(out,'bank')}),journal=await open(join(out,'journal.jsonl'),'wx',0o600)
 const log=async row=>{await journal.writeFile(JSON.stringify(row)+'\n');await journal.sync()}
 const seriesBudget={budgetId:'series/multitask-training-v1',currency:'USD',limitMicrounits:budgetMicrounits}
 bank.createBudget(seriesBudget)
 const cells=new Map(),decisions=new Map(),rows=[]
 let reason=null
 const checkpoint=async()=>{const ledger=bank.getBudget(seriesBudget.budgetId);await writeFile(join(out,'summary.json'),JSON.stringify({schemaVersion:1,rows,budget:ledger,finished:rows.length===tasks.length*seeds.length*rounds,stopReason:reason},null,2),{mode:0o600})}
 try{
  for(const seed of seeds){
   const manifest={schemaVersion:1,experimentId:`multitask-training-v1/seed-${seed}`,mode:'online-train',splits:{train:tasks.map(t=>`${t.request.taskId}-seed-${seed}`),validation:[],test:[]}}
   const policy={...prepared[0].policy,revision:'multitask-training-v1',maxCostMicrounits:budgetMicrounits}
   const feedback=advanceFeedback(bank,{manifest,policy,cutoff:'2000-01-01T00:00:00.000Z'})
   cells.set(seed,{manifest,policy,feedback});await log({type:'empty-history',seed,feedback})
  }
  await checkpoint()
  outer:for(let round=0;round<rounds;round++){
   const order=tasks.flatMap((task,i)=>seeds.map(seed=>({task,i,seed})))
   for(let i=order.length-1;i>0;i--){const j=seededIndex(seeds[0],`round/${round}/shuffle/${i}`,i+1);[order[i],order[j]]=[order[j],order[i]]}
   for(const{task,i,seed}of order){
    signal?.throwIfAborted()
    const ledger=bank.getBudget(seriesBudget.budgetId)
    if(ledger.heldMicrounits||ledger.violated||ledger.remainingMicrounits<reserveFloor){reason='Conservative series reserve/hold stop';break outer}
    const cell=cells.get(seed),request={...structuredClone(task.request),taskId:`${task.request.taskId}-seed-${seed}`}
    const snapshot=readFeedback(bank,cell.feedback).snapshot
    if(snapshot.records.some(r=>!cell.manifest.splits.train.includes(r.taskId)))throw Error('Seed history leakage')
    const evidence=buildTrainingEvidence(snapshot.records,decisions,request.taskId)
    if(evidence.observedAttemptIds.length!==round)throw Error('Same-task history differs from completed rounds')
    const attemptId=`s${seed}-r${round}-t${i}`,intervention=trainingIntervention(round,seed,seeds)
    const job=prepareScenarioJob(task,{method:'metaaco',seed:seededIndex(seed,`${task.request.taskId}/${round}`,0xffffffff)})
    job.policy=cell.policy
    await log({type:'start',attemptId,taskId:task.request.taskId,seed,round,history:cell.feedback,observedAttemptIds:evidence.observedAttemptIds,intervention})
    const start=performance.now(),planned=await planScenarioJob(job,{signal,training:{...evidence,...intervention,exploreTraining:round<2}})
    const plan=planned.plan,route=JSON.parse(routeIdentity(plan)),routeId='learn-'+hash(route).slice(0,24)
    const cost=plan.tasks.reduce((n,t)=>n+job.forecasts[t.model.model].costMicrounits,0)
    const decision={attemptId,taskId:request.taskId,logicalTaskId:task.request.taskId,seed,round,history:cell.feedback,...evidence,intervention,
      route,choices:planned.selection.choices,costMicrounits:cost,planned,selectionWallTimeMs:performance.now()-start}
    await writeFile(join(out,'decisions',attemptId+'.json'),JSON.stringify(decision,null,2),{flag:'wx',mode:0o600});decisions.set(attemptId,decision)
    const strategy=bank.register({schemaVersion:1,strategyId:routeId,version:1,provenance:{source:'multitask-training-v1'},workflow:{name:routeId,description:'Learned skill graph',stages:[{title:'Code',agents:[{id:'coder',prompt:'Implement'}]}]}})
    const candidate={schemaVersion:1,strategy,route:{models:[...new Set(plan.tasks.map(t=>`${t.model.provider}/${t.model.model}`))],tools:[],maxConcurrency:2,tdd:true},taskTypes:[],
      estimates:{wallTimeMs:plan.tasks.length*10000,costMicrounits:cost,quality:null,currency:'USD',source:job.forecastSource}}
    const result=await runAdaptiveAttempt({bank,attemptId,request,baseSnapshot:task.baseSnapshot,feedback:cell.feedback,candidates:[candidate],
      bindings:[{schemaVersion:1,armId:armId(candidate),plan,greenTaskId:plan.tasks.find(t=>t.id==='refactor').dependsOn[0],refactorTaskId:'refactor'}],
      templateSelection:{schemaVersion:1,trainingDecision:decision},componentTaskIds:plan.tasks.filter(t=>t.id.startsWith('implement-')).map(t=>t.id),
      guardedCallsOnly:true,seriesBudget,evaluationDockerImage,allowLlm:true,signal,
      createRuntime:args=>createRuntime?createRuntime({...args,job,task,round,seed,bank}):createScenarioRuntime({...args,scenario:task,componentIds:job.componentIds,limits:job.limits,key,fetchImpl,bank})})
    const a=result.attempt
    rows.push({attemptId,taskId:task.request.taskId,seed,round,routeId,state:a.state,correctness:a.evaluation?.correctness??null,tddCompliance:a.evaluation?.tddCompliance??null,
      historyCount:evidence.observedAttemptIds.length,evidenceCount:evidence.qualityEvidence.reduce((n,r)=>n+r.attempts,0),memorySeeds:planned.selection.initialization?.memorySeeds??0,
      intervention,feedbackBefore:cell.feedback,feedbackAfter:result.feedback,modelCalls:a.outcome?.measured?.observedCallCount??0,costs:a.outcome?.calculated?.costs??[],totalWallTimeMs:performance.now()-start})
    await log({type:'result',row:rows.at(-1)});cell.feedback=result.feedback;await checkpoint()
    if(result.feedbackError)throw Error('Feedback update failed: '+result.feedbackError)
    const events=JSON.stringify(bank.getEvents(attemptId).filter(e=>e.kind==='orchestration-error-v1'||e.kind==='dag-finish-v1'))
    if(/DeepSeek HTTP (401|402|403|429)|Baseline regression gate|Expected RED gate|spawn.*ENOENT|Cannot connect to the Docker daemon/.test(events)||!a.outcome?.measured?.coverageComplete)throw Error('Infrastructure/accounting failure; series stopped')
   }
  }
  await writeFile(join(out,'frozen-training-refs.json'),JSON.stringify(Object.fromEntries([...cells].map(([seed,c])=>[seed,{feedback:c.feedback,manifest:c.manifest}])),null,2),{flag:'wx',mode:0o600})
  await checkpoint();await log({type:'completed',count:rows.length,reason})
  return {rows,budget:bank.getBudget(seriesBudget.budgetId),stopReason:reason}
 }catch(error){reason=error.message;await checkpoint();await log({type:'stopped',reason});throw error}
 finally{try{await writeFile(join(out,'bank-export.jsonl'),bank.exportJsonl(),{flag:'wx',mode:0o600})}finally{try{await journal.close()}finally{bank.close()}}}
}
