import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {StrategyBank} from '../../src/bank/index.js'
import {webhookScenario} from '../../examples/webhook-scenario/index.js'
import {webhookReferenceFiles} from '../fixtures/webhook-reference.js'
import {prepareScenarioJob,planScenarioJob,runScenarioJob,runScenarioTrial,SCENARIO_METHODS} from '../../src/experiments/scenario-study.js'

// Synthetic provider responses, real Harness and independent evaluator; no network or credentials.
for(const method of SCENARIO_METHODS)test(`scenario ${method} preserves limits and independently verifies generated output`,async()=>{
  const scenario=await webhookScenario()
  const job=prepareScenarioJob(scenario,{method})
  if(method!=='direct-pro')job.policy.maxCostMicrounits=987446
  const planned=await planScenarioJob(job)
  assert.ok(planned.plan.tasks.length)
  const root=await mkdtemp(join(tmpdir(),'webhook-launch-test-'))
  const calls=[]
  const architecture={schemaVersion:1,components:[
    {id:'a',files:['app.cjs'],contract:'Public API; use createStore and runOnce from the other modules'},
    {id:'b',files:['store.cjs'],contract:'Export createStore'},
    {id:'c',files:['worker.cjs','signature.cjs'],contract:'Export runOnce and signature helper'},
  ]}
  const fetchImpl=async(_url,options)=>{
    const body=JSON.parse(options.body);calls.push(body)
    const prompt=body.messages[0].content
    let files={...scenario.baseSnapshot.files,...webhookReferenceFiles}
    if(prompt.includes('Return only architecture.json in files.'))files={'architecture.json':JSON.stringify(architecture)}
    else if(prompt.includes('Your component is ')){
      const id=prompt.match(/Your component is ([abc])\./)[1]
      files=Object.fromEntries(architecture.components.find(c=>c.id===id).files.map(path=>[path,webhookReferenceFiles[path]]))
    }else if(prompt.includes('Return analysis.md only.'))files={'analysis.md':'Edge cases reviewed'}
    else if(prompt.includes('Return review.md only.'))files={'review.md':'Reviewed'}
    else if(prompt.includes('in test-plan.md.'))files={'test-plan.md':'Suggested checks'}
    return {ok:true,json:async()=>({model:body.model,usage:{prompt_tokens:10,prompt_cache_miss_tokens:10,prompt_cache_hit_tokens:0,completion_tokens:10,total_tokens:20},
      choices:[{message:{content:JSON.stringify({revision:'mock-output',files})},finish_reason:'stop'}]})}
  }
  try{
    const result=await runScenarioJob({job,out:join(root,'run'),key:'synthetic-test-only',fetchImpl,allowLlm:true})
    assert.equal(result.accounting.heldMicrounits,0)
    assert.ok(result.accounting.spentMicrounits>0)
    assert.equal(result.acceptancePassed,true,JSON.stringify(result))
    assert.ok(calls.length)
    assert.ok(calls.every(call=>call.max_tokens===8192))
    if(method.startsWith('direct-'))assert.equal(calls.length,1)
    if(method==='components')assert.equal(calls.length,6)
    const manifest=JSON.parse(await readFile(join(root,'run','manifest.json'),'utf8'))
    assert.equal(manifest.job.limits.totalOutputTokens,32768)
    assert.equal(manifest.job.history,'empty; no stock observations')
  }finally{await rm(root,{recursive:true,force:true})}
})

test('invalid architecture retains charged call and raw output without dispatching components',async()=>{
  const job=prepareScenarioJob(await webhookScenario(),{method:'components'})
  const root=await mkdtemp(join(tmpdir(),'webhook-rejected-design-'))
  let calls=0
  try{
    await assert.rejects(runScenarioJob({job,out:join(root,'denied')}),/allowLlm/)
    const report=await runScenarioJob({job,out:join(root,'run'),key:'synthetic-test-only',allowLlm:true,fetchImpl:async(_url,options)=>{
      calls++
      return {ok:true,json:async()=>({model:JSON.parse(options.body).model,
        usage:{prompt_tokens:10,prompt_cache_miss_tokens:10,prompt_cache_hit_tokens:0,completion_tokens:10,total_tokens:20},
        choices:[{message:{content:JSON.stringify({revision:'invalid-design',files:{'architecture.json':'{}'}})},finish_reason:'stop'}]})}
    }})
    assert.equal(calls,1)
    assert.equal(report.acceptancePassed,false)
    assert.notEqual(report.attempt.state,'succeeded')
    const bank=new StrategyBank({dataDir:join(root,'run','bank')})
    try{
      const records=bank.exportJsonl().trim().split('\n').map(row=>JSON.parse(row))
      assert.ok(records.some(row=>row.type==='attemptArtifact'&&row.value.name.startsWith('scenario-output-')))
      const accounting=bank.getBudget('attempt/scenario-attempt')
      assert.ok(accounting.spentMicrounits>0)
    }finally{bank.close()}
  }finally{await rm(root,{recursive:true,force:true})}
})


test('incomplete API call keeps its monetary reservation in trial report',async()=>{
  const root=await mkdtemp(join(tmpdir(),'scenario-unknown-api-'))
  try{
    const job=prepareScenarioJob(await webhookScenario(),{method:'direct-flash'})
    job.policy.maxCostMicrounits=1000000
    const report=await runScenarioTrial({job,out:join(root,'run'),key:'synthetic-test-only',allowLlm:true,
      fetchImpl:async()=>{throw Error('Synthetic network interruption')}})
    assert.equal(report.acceptancePassed,false)
    assert.equal(report.accounting.ledgerCreated,true)
    assert.equal(report.accounting.heldMicrounits,job.prices['deepseek-flash'].upperBoundMicrounits)
    assert.equal(report.accounting.coverageComplete,false)
  }finally{await rm(root,{recursive:true,force:true})}
})
