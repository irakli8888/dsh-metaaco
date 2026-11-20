import {readFile,writeFile} from 'node:fs/promises'
import {StrategyBank} from './src/bank/index.js'
const summary=JSON.parse(await readFile('pilot/summary-original.json','utf8'))
for(const method of ['components','metaaco']){
  const bank=new StrategyBank({dataDir:'pilot/'+method+'/bank'})
  let records
  try{records=bank.exportJsonl().trim().split('\n').filter(Boolean).map(JSON.parse);if(bank.listAttempts().length||records.some(r=>r.type==='event'||/budget|reservation|settlement/i.test(r.type)))throw Error('Unexpected dispatch or accounting data')}
  finally{bank.close()}
  const planning=method==='metaaco'
  const reason=JSON.parse(await readFile('pilot/'+method+'/'+(planning?'planning-error':'run-error')+'.json','utf8')).message
  const audit={schemaVersion:1,method,attempts:0,events:0,budgets:0,reason,measuredApiCostMicrounits:0,source:'Failed before attempt/runtime creation; verified zero attempt/event/accounting records'}
  await writeFile('pilot/'+method+'/zero-dispatch-audit.json',JSON.stringify(audit,null,2),{flag:'wx',mode:0o600})
  const row={method,startedAt:summary.rows.find(r=>r.method===method)?.startedAt??null,finishedAt:new Date().toISOString(),state:'failed',acceptancePassed:false,evaluation:null,spentMicrounits:0,heldMicrounits:0,error:reason,failureClass:planning?'local-search-no-feasible-candidate-in-100-evaluations':'candidate-budget-rejection',accountingAudit:method+'/zero-dispatch-audit.json'}
  const index=summary.rows.findIndex(r=>r.method===method)
  if(index<0)summary.rows.push(row);else summary.rows[index]=row
}
summary.spentMicrounits=summary.rows.reduce((n,r)=>n+r.spentMicrounits,0)
summary.heldMicrounits=summary.rows.reduce((n,r)=>n+r.heldMicrounits,0)
summary.remainingMicrounits=summary.protocol.budgetMicrounits-summary.spentMicrounits-summary.heldMicrounits
summary.completedAt=new Date().toISOString()
summary.driverLimitations=['Original driver halted conservatively when no ledger existed','Continuation likewise lacked handling of pre-planning failure','Zero-dispatch audits establish no unknown API expenses for both pre-runtime failures; no paid retries performed']
await writeFile('pilot/summary.json',JSON.stringify(summary,null,2),{mode:0o600})
console.log(JSON.stringify({rows:summary.rows.map(({evaluation,...r})=>r),spentMicrounits:summary.spentMicrounits,heldMicrounits:summary.heldMicrounits},null,2))
