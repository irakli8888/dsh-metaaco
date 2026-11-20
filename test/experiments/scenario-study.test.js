import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {webhookScenario} from '../../examples/webhook-scenario/index.js'
import {prepareScenarioJob,planScenarioJob,runScenarioTrial} from '../../src/experiments/scenario-study.js'

test('scenario uses explicit priors rather than API reservation as cost forecast',async()=>{
  const job=prepareScenarioJob(await webhookScenario())
  assert.ok(job.forecasts['deepseek-flash'].costMicrounits<job.prices['deepseek-flash'].upperBoundMicrounits)
  assert.equal(job.skills.implement[0].costMicrounits,job.forecasts['deepseek-flash'].costMicrounits)
  job.policy.maxCostMicrounits=987446
  const {plan,selection}=await planScenarioJob(job)
  assert.ok(plan.tasks.length>=2)
  assert.ok(selection.initialization)
  assert.ok(selection.evaluations<=100)
})

test('pre-execution failure produces complete zero-dispatch report without requiring a ledger',async()=>{
  const root=await mkdtemp(join(tmpdir(),'scenario-rejection-'))
  let calls=0
  try{
    const job=prepareScenarioJob(await webhookScenario(),{method:'metaaco'})
    job.policy.maxCostMicrounits=0
    const report=await runScenarioTrial({job,out:join(root,'run'),allowLlm:true,fetchImpl:async()=>{calls++;throw Error('No dispatch expected')}})
    assert.equal(report.state,'failed')
    assert.equal(report.attempt,null)
    assert.equal(report.accounting.spentMicrounits,0)
    assert.equal(report.accounting.heldMicrounits,0)
    assert.equal(report.accounting.ledgerCreated,false)
    assert.equal(calls,0)
    assert.deepEqual(JSON.parse(await readFile(join(root,'run','report.json'),'utf8')),report)
  }finally{await rm(root,{recursive:true,force:true})}
})

test('Pro under a dollar reports a pre-dispatch budget block, not code failure',async()=>{
  const root=await mkdtemp(join(tmpdir(),'scenario-pro-limit-'))
  try{
    const job=prepareScenarioJob(await webhookScenario(),{method:'direct-pro'})
    job.policy.maxCostMicrounits=1000000
    const report=await runScenarioTrial({job,out:join(root,'run'),allowLlm:true,fetchImpl:()=>{throw Error('Must not dispatch')}})
    assert.equal(report.attempt,null)
    assert.match(report.error.message,/per-call reservation/)
    assert.equal(report.accounting.spentMicrounits,0)
  }finally{await rm(root,{recursive:true,force:true})}
})
