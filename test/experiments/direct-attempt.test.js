import {test} from 'node:test'
import assert from 'node:assert/strict'
import {runDirectAttempt} from '../../src/experiments/direct-attempt.js'
import {fixture,snapshot,price} from '../fixtures/adaptive.js'

test('direct baseline makes one call, passes acceptance and retains incomplete TDD',async t=>{
  const f=fixture(t),starts=[]
  const route={id:'direct-flash',plan:{...f.plan,tasks:[f.plan.tasks[0]]},wallTimeMs:100,costMicrounits:10}
  const createRuntime=async({guardAdapter,signal})=>{
    const adapter=guardAdapter({async *stream(){yield{type:'usage',usage:{inputTokens:2,outputTokens:1}};yield{type:'finish',reason:{kind:'stop'}}}},()=>({pricing:price,upperBoundMicrounits:6}))
    return{parent:{id:'parent'},subagentProvider:'offline',async dispose(){},ctx:{workflowEngine:{start(req){
      starts.push(req.args.taskId)
      const result=(async()=>{for await(const part of adapter.stream({...req.args.model,signal})){};return{stopReason:'completed',value:JSON.stringify(snapshot('answer'))}})()
      return{id:'one',result,cancel(){},async dispose(){}}
    }}}}
  }
  const result=await runDirectAttempt({bank:f.bank,attemptId:'direct',task:{request:f.request,baseSnapshot:f.base},route,policy:f.policy,createRuntime,allowLlm:true})
  assert.deepEqual(starts,['green'])
  assert.equal(result.attempt.evaluation.correctness,'passed')
  assert.equal(result.attempt.evaluation.tddCompliance,'inconclusive')
  assert.equal(result.attempt.state,'inconclusive')
  assert.equal(result.attempt.outcome.measured.observedCallCount,1)
  assert.equal(result.attempt.outcome.measured.coverageComplete,true)
})

test('direct baseline requires consent before starting any attempt',async()=>{
  await assert.rejects(runDirectAttempt({}),/allowLlm/)
})
