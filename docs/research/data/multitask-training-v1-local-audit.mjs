import {readFile,writeFile,readdir,mkdir}from 'node:fs/promises'
import {resolve,join}from 'node:path'
import {pathToFileURL}from 'node:url'
import assert from 'node:assert/strict'
import {createHash}from 'node:crypto'
const {StrategyBank}=await import(pathToFileURL(resolve('src/bank/index.js')))
const {readFeedback}=await import(pathToFileURL(resolve('src/feedback/index.js')))
const {buildTrainingEvidence}=await import(pathToFileURL(resolve('src/experiments/scenario-training.js')))
const {hash}=await import(pathToFileURL(resolve('src/selector/contracts.js')))
const root=resolve('work/multitask-training-v1-4918506/study'),manifest=JSON.parse(await readFile(join(root,'manifest.json'),'utf8')),summary=JSON.parse(await readFile(join(root,'summary.json'),'utf8'))
const {configHash,startedAt,...config}=manifest
assert.equal(hash(config),configHash);assert.equal(summary.finished,true);assert.equal(summary.stopReason,null);assert.equal(summary.rows.length,24)
const exported=await readFile(join(root,'bank-export.jsonl'),'utf8'),records=exported.trim().split('\n').map(JSON.parse)
const bank=new StrategyBank({dataDir:join(root,'bank')}),decisions=new Map()
for(const row of summary.rows)decisions.set(row.attemptId,JSON.parse(await readFile(join(root,'decisions',row.attemptId+'.json'),'utf8')))
const artifacts=records.filter(r=>r.type==='artifact').map(r=>r.value),refs=new Map(records.filter(r=>r.type==='attemptArtifact').map(r=>[r.value.attemptId+'/'+r.value.name,r.value]))
const values=new Map(records.filter(r=>r.type==='attempt').map(r=>[r.value.attemptId,r.value])),rows=[],environments=[]
let callsTotal=0,spent=0,normalizations=0
try{
 assert.equal(bank.exportJsonl(),exported)
 for(const artifact of artifacts)bank.getArtifact(artifact)
 for(const row of summary.rows){
  const a=values.get(row.attemptId),d=decisions.get(row.attemptId),before=readFeedback(bank,row.feedbackBefore),after=readFeedback(bank,row.feedbackAfter)
  const alias=`${row.taskId}-seed-${row.seed}`
  assert.equal(a.request.taskId,alias)
  assert.ok(before.snapshot.records.every(r=>r.taskId.endsWith('-seed-'+row.seed)))
  assert.ok(before.snapshot.records.every(r=>Date.parse(r.finishedAt)<Date.parse(before.revision.cutoff)&&r.attemptId!==row.attemptId))
  const evidence=buildTrainingEvidence(before.snapshot.records,decisions,alias)
  assert.equal(evidence.observedAttemptIds.length,row.round)
  for(const key of ['observedAttemptIds','qualityEvidence','warmStartChoices'])assert.deepEqual(evidence[key],d[key])
  assert.equal(after.snapshot.records.length,before.snapshot.records.length+1)
  assert.ok(after.snapshot.records.some(r=>r.attemptId===row.attemptId))
  const events=records.filter(r=>r.type==='event'&&r.value.attemptId===row.attemptId).map(r=>r.value)
  const phases=events.filter(e=>e.kind==='evaluation-phase').map(e=>({phase:e.payload.phase,suites:e.payload.reports.map(r=>{
   if(r.spawnError||r.runnerError||r.integrityError)environments.push({attemptId:row.attemptId,phase:e.payload.phase,report:r})
   return {id:r.suiteId,status:r.status,counts:r.counts,exitCode:r.exitCode,snapshotHash:r.snapshotHash,testSuiteHash:r.testSuiteHash,
    failed:r.tests.filter(t=>t.type==='test:fail').map(t=>({name:t.name,message:t.message,code:t.code})),stopReason:r.stopReason}
  })}))
  const calls=a.outcome.calls;assert.equal(calls.length,row.modelCalls)
  assert.equal(a.outcome.measured.coverageComplete,true)
  assert.ok(calls.every(c=>c.status==='completed'&&c.calculatedCost.microunits!==null))
  const cost=calls.reduce((n,c)=>n+c.calculatedCost.microunits,0)
  assert.equal(cost,row.costs[0].microunits);spent+=cost;callsTotal+=calls.length
  const failureReasons=events.filter(e=>e.kind==='dag-task-v1'&&e.payload.state==='failed').map(e=>({task:e.payload.id,reason:e.payload.reason.split('\n')[0]}))
  for(const ref of refs.values())if(ref.attemptId===row.attemptId&&ref.name.startsWith('scenario-normalized-')){
   const rawRef=refs.get(row.attemptId+'/scenario-output-'+ref.name.slice('scenario-normalized-'.length))
   const raw=JSON.parse(await readFile(join(root,'bank/artifacts',rawRef.sha256),'utf8')),normalized=JSON.parse(await readFile(join(root,'bank/artifacts',ref.sha256),'utf8'))
   if(raw.kind==='files')assert.ok(Object.entries(raw.files).every(([name,value])=>normalized.files[name]===value))
   else assert.deepEqual(JSON.parse(normalized.files['architecture.json']).components,raw.components)
   if(Object.hasOwn(normalized.files,'README.md'))assert.equal(normalized.files['README.md'],a.request.testSpec.acceptanceCriteria[0])
   normalizations++
  }
  if(row.state==='succeeded'){
   assert.equal(a.evaluation.provenance.source,'independent-node-evaluator')
   assert.equal(a.evaluation.tddCompliance,'passed')
   const ref=refs.get(row.attemptId+'/dag-output/refactor'),snapshot=JSON.parse(await readFile(join(root,'bank/artifacts',ref.sha256),'utf8'))
   const dest=resolve('work/multitask-training-v1-4918506/generated',row.attemptId);await mkdir(dest,{recursive:true})
   for(const[name,content]of Object.entries(snapshot.files)){const path=join(dest,name);await mkdir(resolve(path,'..'),{recursive:true});await writeFile(path,content)}
  }
  rows.push({...row,selectionWallTimeMs:d.selectionWallTimeMs,choices:d.choices,route:d.route,qualityEvidence:d.qualityEvidence,observedAttemptIds:d.observedAttemptIds,
   search:{evaluations:d.planned.selection.evaluations,initialization:d.planned.selection.initialization,exploration:d.planned.selection.exploration??null},
   phases,failureReasons,calls:calls.map(({callId,provider,model,modelRevision,status,latencyMs,usage,calculatedCost,pricing})=>({callId,provider,model,modelRevision,status,latencyMs,usage,calculatedCost,pricingId:pricing.id}))})
 }
 const ledger=bank.getBudget('series/multitask-training-v1')
 assert.equal(spent,ledger.spentMicrounits);assert.equal(ledger.heldMicrounits,0);assert.equal(ledger.reservations.length,callsTotal)
 const frozen=JSON.parse(await readFile(join(root,'frozen-training-refs.json'),'utf8')),finalStats=[]
 for(const seed of config.seeds){
  const final=readFeedback(bank,frozen[seed].feedback);assert.equal(final.snapshot.records.length,12)
  for(const task of config.tasks){const alias=`${task.request.taskId}-seed-${seed}`,e=buildTrainingEvidence(final.snapshot.records,decisions,alias);assert.equal(e.observedAttemptIds.length,4);finalStats.push({taskId:task.request.taskId,seed,...e})}
 }
 const ablation=JSON.parse(await readFile(join(root,'selection-ablation.json'),'utf8'));assert.equal(ablation.rows.length,12);assert.equal(ablation.paidCalls,0)
 const digest=async path=>createHash('sha256').update(await readFile(path)).digest('hex')
 const fileHashes={}
 for(const file of ['manifest.json','summary.json','journal.jsonl','bank-export.jsonl','frozen-training-refs.json','selection-ablation.json'])fileHashes[file]=await digest(join(root,file))
 for(const file of await readdir(join(root,'decisions')))fileHashes['decisions/'+file]=await digest(join(root,'decisions',file))
 const out={schemaVersion:1,sourceCommit:config.provenance.commit,archiveSha256:config.provenance.archiveSha256,configHash,startedAt,budgetLimitMicrounits:config.budgetMicrounits,
  counts:{attempts:rows.length,successes:rows.filter(r=>r.state==='succeeded').length,modelCalls:callsTotal,verifiedArtifacts:artifacts.length,normalizedOutputs:normalizations},
  spentMicrounits:spent,heldMicrounits:0,remainingMicrounits:ledger.remainingMicrounits,costIsCalculatedNotInvoice:true,
  rows,finalStats,selectionAblation:ablation,environmentIssues:environments,frozenRefs:frozen,evidenceSha256:fileHashes,
  validation:{sealedPastOnly:true,seedIsolation:true,taskIsolation:true,historyCounts:[0,1,2,3],sourcePreserved:true,rawArtifactsVerified:true,ledgerReconciled:true}}
 await writeFile('docs/research/data/multitask-training-v1-summary.json',JSON.stringify(out,null,2)+'\n')
 console.log(JSON.stringify({counts:out.counts,spent,environmentIssues:environments.length,rounds:[0,1,2,3].map(round=>({round,successes:rows.filter(r=>r.round===round&&r.state==='succeeded').length,cost:rows.filter(r=>r.round===round).reduce((n,r)=>n+r.costs[0].microunits,0)})),changed:ablation.rows.filter(r=>r.changed).length}))
}finally{bank.close()}
