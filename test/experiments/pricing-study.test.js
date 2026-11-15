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

test('pricing model output overlays only the permitted file', async () => {
  const { applySnapshotPatch } = await import('../../src/orchestration/snapshot-patch.js')
  const base = { revision: 'base', files: { 'pricing.js': 'old', 'index.js': 'pinned' } }
  const patch = { revision: 'green', files: { 'pricing.js': 'new' } }
  assert.deepEqual(applySnapshotPatch(base, patch, ['pricing.js']),
    { revision: 'green', files: { 'pricing.js': 'new', 'index.js': 'pinned' } })
  assert.throws(() => applySnapshotPatch(base, { ...patch, files: { ...patch.files, 'index.js': 'changed' } },
    ['pricing.js']), /not editable/)
})

test('compact edits require a unique match and cannot target another file', async () => {
  const { applyTextEdits } = await import('../../src/orchestration/snapshot-patch.js')
  const base = { revision: 'base', files: { 'pricing.js': 'old old', 'index.js': 'pinned' } }
  const edit = { path: 'pricing.js', before: 'old old', after: 'new' }
  assert.deepEqual(applyTextEdits(base, { revision: 'green', edits: [edit] }, ['pricing.js']),
    { revision: 'green', files: { 'pricing.js': 'new', 'index.js': 'pinned' } })
  assert.throws(() => applyTextEdits(base, { revision: 'green', edits: [{ ...edit, before: 'old' }] },
    ['pricing.js']), /unique/)
  assert.throws(() => applyTextEdits(base, { revision: 'green', edits: [{ ...edit, path: 'index.js' }] },
    ['pricing.js']), /not editable/)
})
