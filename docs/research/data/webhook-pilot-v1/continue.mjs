import {readFile,writeFile} from 'node:fs/promises'
import {StrategyBank} from './src/bank/index.js'
import {webhookScenario} from './examples/webhook-scenario/index.js'
import {prepareScenarioJob,runScenarioJob} from './src/experiments/scenario-study.js'
const summary=JSON.parse(await readFile('pilot/summary.json','utf8'))
await writeFile('pilot/summary-original.json',JSON.stringify(summary,null,2),{flag:'wx',mode:0o600})
const bank=new StrategyBank({dataDir:'pilot/components/bank'})
let audit
try{
  const records=bank.exportJsonl().trim().split('\n').filter(Boolean).map(JSON.parse)
  audit={schemaVersion:1,method:'components',attempts:bank.listAttempts().length,events:records.filter(r=>r.type==='event').length,budgets:records.filter(r=>/budget|reservation|settlement/i.test(r.type)).length,
    reason:JSON.parse(await readFile('pilot/components/run-error.json','utf8')).message,source:'Strategy selector rejected before beginAttempt/createRuntime; no provider initialization'}
  if(audit.attempts||audit.events||audit.budgets||audit.reason!=='No admissible strategy')throw Error('Cannot clear unknown accounting hold')
}finally{bank.close()}
await writeFile('pilot/components/accounting-audit.json',JSON.stringify(audit,null,2),{flag:'wx',mode:0o600})
const component=summary.rows.find(row=>row.method==='components')
component.spentMicrounits=0;component.heldMicrounits=0;component.accountingAudit='components/accounting-audit.json'
summary.heldMicrounits=0
summary.remainingMicrounits=summary.protocol.budgetMicrounits-summary.spentMicrounits
const job=prepareScenarioJob(await webhookScenario(),{method:'metaaco',seed:summary.protocol.seed})
job.policy.maxCostMicrounits=summary.remainingMicrounits
job.provenance={sourceCommit:summary.protocol.sourceCommit,sourceArchiveSha256:summary.protocol.sourceArchiveSha256,protocolId:summary.protocol.id}
const startedAt=new Date().toISOString()
console.log('START metaaco after zero-dispatch accounting audit')
let report,error
try{report=await runScenarioJob({job,out:'pilot/metaaco',evaluationDockerImage:summary.protocol.image,key:(await readFile('/home/irakli/.config/dsh-metaaco/deepseek.key','utf8')).trim(),allowLlm:true})}catch(e){error=e.message}
let ledger
const resultBank=new StrategyBank({dataDir:'pilot/metaaco/bank'})
try{ledger=resultBank.getBudget('attempt/scenario-attempt');await writeFile('pilot/metaaco/bank-export.jsonl',resultBank.exportJsonl(),{flag:'wx',mode:0o600})}finally{resultBank.close()}
summary.rows.push({method:'metaaco',startedAt,finishedAt:new Date().toISOString(),state:report?.attempt.state??'failed',acceptancePassed:report?.acceptancePassed??false,
  evaluation:report?.attempt.evaluation??null,spentMicrounits:ledger.spentMicrounits,heldMicrounits:ledger.heldMicrounits,error:error??null})
summary.spentMicrounits+=ledger.spentMicrounits;summary.heldMicrounits+=ledger.heldMicrounits
summary.remainingMicrounits=summary.protocol.budgetMicrounits-summary.spentMicrounits-summary.heldMicrounits
summary.completedAt=new Date().toISOString()
await writeFile('pilot/summary.json',JSON.stringify(summary,null,2),{mode:0o600})
console.log('DONE metaaco '+report?.attempt.state+' cost='+ledger.spentMicrounits)
