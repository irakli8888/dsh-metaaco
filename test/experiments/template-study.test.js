import assert from 'node:assert/strict'
import { test } from 'node:test'
import { templateStudyTasks } from '../../examples/template-study-tasks.js'
import { TDDEvaluator } from '../../src/evaluation/index.js'

import { controlSnapshot } from './template-study-controls.js'

const dockerImage = process.env.TEST_EVALUATION_IMAGE

for (const { request, baseSnapshot } of templateStudyTasks()) {
  test(`study baseline, RED and GREEN: ${request.taskId}`, async () => {
    const evaluator = new TDDEvaluator({ spec: request.testSpec })
    const baseline = await evaluator.runPhase('baseline', baseSnapshot, { dockerImage })
    assert.equal(baseline.reports[0].status, 'passed')
    const red = await evaluator.runPhase('red', baseSnapshot, { dockerImage })
    const failures = red.reports[0].tests.filter(row => row.type === 'test:fail')
    assert.equal(red.reports[0].status, 'failed')
    assert.deepEqual(failures.map(row => row.name).sort(), request.testSpec.suites[0].expectedRedTests)
    assert.ok(failures.every(row => row.code === 'ERR_ASSERTION'))
    const green = await evaluator.runPhase('green', controlSnapshot(request.taskId), { dockerImage })
    assert.deepEqual(green.reports.map(report => report.status), ['passed', 'passed'])
  })
}
