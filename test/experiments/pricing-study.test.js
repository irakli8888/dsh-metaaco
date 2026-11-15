import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pricingStudyTask } from '../../examples/pricing-study-task.js'
import { TDDEvaluator } from '../../src/evaluation/index.js'

test('repository pricing case preserves baseline and produces expected RED', async () => {
  const { baseSnapshot, request } = pricingStudyTask(process.cwd())
  const evaluator = new TDDEvaluator({ spec: request.testSpec })
  const options = { dockerImage: process.env.TEST_EVALUATION_IMAGE }
  const baseline = await evaluator.runPhase('baseline', baseSnapshot, options)
  assert.equal(baseline.reports[0].status, 'passed')
  const red = await evaluator.runPhase('red', baseSnapshot, options)
  const failures = red.reports[0].tests.filter(row => row.type === 'test:fail')
  assert.equal(red.reports[0].status, 'failed')
  assert.deepEqual(failures.map(row => row.name).sort(), request.testSpec.suites[0].expectedRedTests.toSorted())
  assert.ok(failures.every(row => row.code === 'ERR_ASSERTION'))
})
