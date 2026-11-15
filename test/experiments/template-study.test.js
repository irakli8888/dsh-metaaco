import assert from 'node:assert/strict'
import { test } from 'node:test'
import { templateStudyTasks } from '../../examples/template-study-tasks.js'
import { TDDEvaluator } from '../../src/evaluation/index.js'

for (const { request, baseSnapshot } of templateStudyTasks()) {
  test(`study baseline and RED: ${request.taskId}`, async () => {
    const evaluator = new TDDEvaluator({ spec: request.testSpec })
    const baseline = await evaluator.runPhase('baseline', baseSnapshot)
    assert.equal(baseline.reports[0].status, 'passed')
    const red = await evaluator.runPhase('red', baseSnapshot)
    const failures = red.reports[0].tests.filter(row => row.type === 'test:fail')
    assert.equal(red.reports[0].status, 'failed')
    assert.deepEqual(failures.map(row => row.name).sort(), request.testSpec.suites[0].expectedRedTests)
    assert.ok(failures.every(row => row.code === 'ERR_ASSERTION'))
  })
}
