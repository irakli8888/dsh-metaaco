import {test} from 'node:test'
import assert from 'node:assert/strict'
import {webhookScenario} from '../../examples/webhook-scenario/index.js'

test('webhook v2 provides a short brief and only external service contracts',async()=>{
  const scenario=await webhookScenario()
  assert.equal(scenario.request.taskId,'webhook-retry-v2')
  assert.ok(scenario.userBrief.length<600)
  assert.deepEqual(Object.keys(scenario.baseSnapshot.files).sort(),['README.md','app.cjs'])
  assert.ok(scenario.baseSnapshot.files['README.md'].includes('/events'))
  assert.equal(scenario.componentOwnership,undefined)
  assert.equal(/claim\(|settle\(|addSubscription\(|signature\.sign|store\.cjs/.test(scenario.request.description),false)
  const target=scenario.request.testSpec.suites[0].files['acceptance.test.cjs']
  assert.equal(/require\('\.\/(store|worker|signature)\.cjs'\)/.test(target),false)
})
