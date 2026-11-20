import { TDDEvaluator } from '../evaluation/index.js'
import { MetricsCollector, BudgetController } from '../metrics/index.js'
import { createBudgetedAdapter } from '../adapters/harness/budget.js'
import { runDag, validateDag } from '../execution/index.js'

/** Research-only single call. Bank keeps TDD inconclusive when refactor evidence is absent. */
export async function runDirectAttempt({bank,attemptId,task,route,policy,createRuntime,evaluationDockerImage,allowLlm=false,signal,selection=null}) {
  if(allowLlm!==true) throw Error('Explicit allowLlm: true required')
  signal?.throwIfAborted()
  const plan=validateDag(route.plan)
  if(plan.tasks.length!==1 || plan.tasks[0].dependsOn.length || !policy.allowedModels.includes(`${plan.tasks[0].model.provider}/${plan.tasks[0].model.model}`)) throw Error('Direct baseline requires one allowed model node')
  const strategy=bank.register({schemaVersion:1,strategyId:route.id,version:1,provenance:{source:'direct-prompt-v1'},
    workflow:{name:route.id,description:'One coding request',stages:[{title:'Code',agents:[{id:'coder',prompt:'Implement'}]}]}})
  bank.beginAttempt({attemptId,request:task.request,strategy,selection:{protocol:'direct-prompt-v1',primaryMetric:'acceptance-correctness',tddRequiredForPrimary:false,experimentSelection:selection}})
  const collector=new MetricsCollector({bank,attemptId,estimates:{wallTimeMs:route.wallTimeMs,costMicrounits:route.costMicrounits,quality:null,currency:policy.currency,source:'Fixed direct forecast'}})
  const budget=new BudgetController({bank,budgetId:`attempt/${attemptId}`,currency:policy.currency,limitMicrounits:policy.maxCostMicrounits})
  const deadline=AbortSignal.timeout(policy.maxWallTimeMs)
  const combined=signal?AbortSignal.any([signal,deadline]):deadline
  const evaluator=new TDDEvaluator({bank,attemptId,spec:task.request.testSpec})
  let runtime,execution,error
  try {
    const baseline=await evaluator.runPhase('baseline',task.baseSnapshot,{signal:combined,dockerImage:evaluationDockerImage})
    if(!baseline.reports.every(r=>r.status==='passed')) throw Error('Baseline regression gate did not pass')
    const red=await evaluator.runPhase('red',task.baseSnapshot,{signal:combined,dockerImage:evaluationDockerImage})
    for(const report of red.reports){
      const suite=task.request.testSpec.suites.find(s=>s.id===report.suiteId)
      const failed=report.tests.filter(t=>t.type==='test:fail'&&!t.skip&&!t.todo)
      if(report.status!=='failed'||!failed.every(t=>t.code==='ERR_ASSERTION')||JSON.stringify(failed.map(t=>t.name).sort())!==JSON.stringify([...suite.expectedRedTests].sort())) throw Error('Expected RED gate did not pass')
    }
    runtime=await createRuntime({attemptId,signal:combined,plan,
      guardAdapter:(adapter,quote)=>createBudgetedAdapter(adapter,{collector,budget,attemptId,quote,models:policy.allowedModels,tools:[],allowLlm:true,signal:combined})})
    if(typeof runtime?.dispose!=='function') throw Error('Runtime must provide dispose()')
    execution=await runDag(runtime.ctx,runtime.parent,plan,{bank,attemptId,allowLlm:true,signal:combined,
      subagentProvider:runtime.subagentProvider,verifyArtifact:async({artifact,signal})=>{
        const snapshot=JSON.parse(bank.getArtifact(artifact))
        const green=await evaluator.runPhase('green',snapshot,{signal,dockerImage:evaluationDockerImage})
        if(!green.reports.every(r=>r.status==='passed')) throw Error('Independent GREEN gate did not pass')
      }})
  }catch(caught){error=caught}
  finally{try{await runtime?.dispose?.()}catch(caught){error??=caught}}
  const calls=bank.getEvents(attemptId).filter(e=>e.kind==='metrics-v1'&&e.payload.data.type==='call').map(e=>e.payload.data.record)
  const ledger=budget.snapshot()
  const coverageComplete=calls.length>0 && !ledger.violated && ledger.reservations.length===calls.length && calls.every(call=>call.status==='completed'&&call.calculatedCost.microunits!==null&&ledger.reservations.some(r=>r.reservationId===call.callId&&r.settlement?.actualMicrounits===call.calculatedCost.microunits))
  collector.finish(error?'failed':'completed',{coverageComplete})
  const outcome=collector.snapshot()
  bank.attachArtifact(attemptId,'attempt-metrics',bank.putArtifact(Buffer.from(JSON.stringify(outcome))))
  if(error) bank.appendEvent(attemptId,'direct-error',{kind:'direct-error-v1',payload:{message:error.message}})
  if(combined.aborted){
    if(signal?.aborted) bank.cancelAttempt(attemptId,'Direct baseline cancelled')
    else bank.timeoutAttempt(attemptId,'Direct baseline deadline',outcome)
  }else if(error){
    const evaluation=evaluator.evaluate()
    bank.attachArtifact(attemptId,'independent-evaluation',bank.putArtifact(Buffer.from(JSON.stringify(evaluation))))
    bank.finalizeAttempt(attemptId,evaluation.correctness==='failed'?evaluation:{status:'failed',requiredTests:[],provenance:{source:'direct-prompt-v1',reason:error.message}},outcome)
  }else evaluator.finalize(outcome)
  return {attempt:bank.getAttempt(attemptId),execution}
}
