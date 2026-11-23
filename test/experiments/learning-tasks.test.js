import {test} from 'node:test'
import assert from 'node:assert/strict'
import {learningTasks} from '../../examples/learning-tasks/index.js'
import {TDDEvaluator} from '../../src/evaluation/index.js'
import {learningReferenceFiles} from '../fixtures/learning-reference.js'

test('new train tasks have assertion RED and reference GREEN/REFACTOR without oracle in prompts',async()=>{
 for(const task of await learningTasks()){
  assert.equal(task.split,'train')
  const e=new TDDEvaluator({spec:task.request.testSpec})
  assert.ok((await e.runPhase('baseline',task.baseSnapshot)).reports.every(r=>r.status==='passed'))
  const red=await e.runPhase('red',task.baseSnapshot)
  const failures=red.reports.flatMap(r=>r.tests.filter(t=>t.type==='test:fail'))
  assert.equal(failures.length,8,task.request.taskId)
  assert.ok(failures.every(t=>t.code==='ERR_ASSERTION'),JSON.stringify(red))
  const snapshot={revision:'reference',files:{...task.baseSnapshot.files,'app.cjs':learningReferenceFiles[task.request.taskId]}}
  await e.runPhase('green',snapshot);await e.runPhase('refactor',snapshot)
  assert.equal(e.evaluate().status,'success',JSON.stringify(e.evaluate()))
  assert.equal(JSON.stringify(task).includes('learningReferenceFiles'),false)
 }
})

for(const [id,before,after]of[
 ['lease-queue-train-v1','j.token=String(++serial)','j.token="constant"'],
 ['wallet-ledger-train-v1',"if(balances.get(from)<value)return fail('funds')","if(false)return fail('funds')"],
 ['ttl-cache-train-v1','if(generation===(versions.get(k)||0))','if(true)'],
])test(`train acceptance detects calibration mutation ${id}`,async()=>{
 const task=(await learningTasks()).find(t=>t.request.taskId===id)
 const {runSuite}=await import('../../src/evaluation/runner.js')
 const code=learningReferenceFiles[id].replace(before,after);assert.notEqual(code,learningReferenceFiles[id])
 const report=await runSuite(task.request.testSpec,task.request.testSpec.suites[0],{revision:'mutant',files:{...task.baseSnapshot.files,'app.cjs':code}})
 assert.equal(report.status,'failed')
 assert.ok(report.tests.some(t=>t.type==='test:fail'&&t.code==='ERR_ASSERTION'))
})
