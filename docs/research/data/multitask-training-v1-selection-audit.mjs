// Post-hoc local-search-only mechanism audit; never executes an API/model or evaluator.
import {readFile,writeFile}from 'node:fs/promises'
import {join}from 'node:path'
import {prepareScenarioJob,planScenarioJob}from './src/experiments/scenario-study.js'
import {routeIdentity}from './src/experiments/skill-search.js'
import {seededIndex}from './src/selector/index.js'
const manifest=JSON.parse(await readFile('study/manifest.json','utf8'))
const summary=JSON.parse(await readFile('study/summary.json','utf8'))
if(!summary.finished)throw Error('Audit requires completed series; no interference with training')
const rows=[]
for(const row of summary.rows.filter(r=>r.round>=2)){
 const decision=JSON.parse(await readFile(join('study/decisions',row.attemptId+'.json'),'utf8'))
 const task=manifest.tasks.find(t=>t.request.taskId===row.taskId)
 const job=prepareScenarioJob(task,{method:'metaaco',seed:seededIndex(row.seed,`${row.taskId}/${row.round}`,0xffffffff)})
 job.policy.maxCostMicrounits=manifest.budgetMicrounits
 const noHistory=await planScenarioJob(job)
 rows.push({attemptId:row.attemptId,taskId:row.taskId,seed:row.seed,round:row.round,observedAttemptIds:decision.observedAttemptIds,
  withHistory:{route:decision.route,choices:decision.choices,evaluations:decision.planned.selection.evaluations,initialization:decision.planned.selection.initialization},
  withoutHistory:{route:JSON.parse(routeIdentity(noHistory.plan)),choices:noHistory.selection.choices,evaluations:noHistory.selection.evaluations},
  changed:JSON.stringify(decision.route)!==routeIdentity(noHistory.plan),actualState:row.state,counterfactualOutcome:null})
}
await writeFile('study/selection-ablation.json',JSON.stringify({schemaVersion:1,kind:'post-hoc-mechanism-audit-not-outcome-baseline',paidCalls:0,
 sourceCommit:manifest.provenance.commit,rows,caveat:'Only local selections rerun; no counterfactual API outcomes, causal success effect or generalization measured'},null,2),{flag:'wx',mode:0o600})
console.log(JSON.stringify({audited:rows.length,changed:rows.filter(r=>r.changed).length,paidCalls:0}))
