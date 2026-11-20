import {test} from 'node:test'
import assert from 'node:assert/strict'
import {webhookScenario} from '../../examples/webhook-scenario/index.js'
import {webhookReferenceFiles, webhookMonolithicReferenceFiles} from '../fixtures/webhook-reference.js'
import {TDDEvaluator} from '../../src/evaluation/index.js'

test('webhook task establishes assertion RED and independent reference passes all gates',async()=>{
  const scenario=await webhookScenario()
  const evaluator=new TDDEvaluator({spec:scenario.request.testSpec})
  const baseline=await evaluator.runPhase('baseline',scenario.baseSnapshot)
  assert.ok(baseline.reports.every(r=>r.status==='passed'))
  const red=await evaluator.runPhase('red',scenario.baseSnapshot)
  const failures=red.reports.flatMap(r=>r.tests.filter(t=>t.type==='test:fail'))
  assert.equal(failures.length,12)
  assert.ok(failures.every(t=>t.code==='ERR_ASSERTION'))
  assert.deepEqual(failures.map(t=>t.name).sort(),scenario.request.testSpec.suites[0].expectedRedTests.toSorted())
  await evaluator.runPhase('green',{revision:'oracle-green',files:{...scenario.baseSnapshot.files,...webhookReferenceFiles}})
  await evaluator.runPhase('refactor',{revision:'oracle-refactor',files:{...scenario.baseSnapshot.files,...webhookReferenceFiles}})
  const result=evaluator.evaluate()
  assert.equal(result.correctness,'passed')
  assert.equal(result.status,'success')
  assert.equal(JSON.stringify(scenario).includes('webhookReferenceFiles'),false)
})

for(const [name,file,before,after,expectedTest] of [
  ['double claim','store.cjs','delivery.claimed=true;','delivery.claimed=false;','concurrent workers cannot send same delivery'],
  ['incorrect signature','signature.cjs','.update(body)','.update("wrong")','signature hashes exact wire bytes'],
  ['retry too early','store.cjs','now+retryDelayMs','now','exception schedules retry and respects injected clock'],
]) test(`acceptance suite detects ${name}`,async()=>{
  const {runSuite}=await import('../../src/evaluation/runner.js')
  const scenario=await webhookScenario()
  const files={...scenario.baseSnapshot.files,...webhookReferenceFiles,[file]:webhookReferenceFiles[file].replace(before,after)}
  assert.notEqual(files[file],webhookReferenceFiles[file])
  const report=await runSuite(scenario.request.testSpec,scenario.request.testSpec.suites[0],{revision:'mutant',files})
  assert.equal(report.status,'failed')
  assert.ok(report.tests.some(t=>t.type==='test:fail'&&t.code==='ERR_ASSERTION'&&t.name===expectedTest))
})

test('prepared scenarios are detached from shared baseline and ownership',async()=>{
  const first=await webhookScenario()
  first.baseSnapshot.files['app.cjs']='modified'
  first.decomposition.status='modified'
  const second=await webhookScenario()
  assert.notEqual(second.baseSnapshot.files['app.cjs'],'modified')
  assert.equal(second.decomposition.status,'requires-design-artifact')
})

test('public tests accept a single-file implementation without private modules',async()=>{
  const {runSuite}=await import('../../src/evaluation/runner.js')
  const scenario=await webhookScenario()
  const files={...scenario.baseSnapshot.files,...webhookMonolithicReferenceFiles}
  assert.deepEqual(Object.keys(files).sort(),['README.md','app.cjs'])
  for(const suite of scenario.request.testSpec.suites){
    const report=await runSuite(scenario.request.testSpec,suite,{revision:'monolithic-oracle',files})
    assert.equal(report.status,'passed')
  }
})
