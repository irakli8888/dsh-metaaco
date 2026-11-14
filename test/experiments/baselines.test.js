import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from '../fixtures/adaptive.js'
import { selectStrategy, createSelectorSnapshot } from '../../src/selector/index.js'
import { armId } from '../../src/selector/contracts.js'
function choices(t) {
  const f = fixture(t), b = structuredClone(f.candidate)
  b.strategy.strategyId = 'other'; b.estimates.costMicrounits = 1
  f.bank.register({ ...f.bank.getStrategy('tdd', 1), strategyId: 'other' })
  const args = { request: f.request, candidates: [f.candidate, b], policy: f.policy,
    snapshot: createSelectorSnapshot(f.bank, { trainingTaskIds: ['train'], cutoff: '2000-01-01T00:00:00.000Z' }) }
  return { ...f, b, args }
}
test('fixed and cheapest choose their declared arms and identify the true algorithm', t => {
  const f = choices(t)
  const fixed = selectStrategy({ ...f.args, method: { kind: 'fixed', armId: armId(f.candidate) } })
  const cheap = selectStrategy({ ...f.args, method: { kind: 'cheapest' } })
  assert.equal(fixed.selected.armId, armId(f.candidate)); assert.equal(cheap.selected.armId, armId(f.b))
  assert.equal(fixed.algorithm, 'fixed-v1'); assert.equal(cheap.algorithm, 'cheapest-v1')
  assert.equal(cheap.training.length, 0)
})
test('seeded random is invariant to candidate order, reproducible, and respects exclusions', t => {
  const f = choices(t), choose = args => selectStrategy({ ...f.args, ...args, method: { kind: 'random', seed: 42 }, selectedAt: '2026-11-14T00:00:00.000Z' })
  assert.deepEqual(choose({}), choose({ candidates: [...f.args.candidates].reverse() }))
  assert.equal(choose({}).propensity, 0.5)
  const bad = structuredClone(f.b); bad.route.models = ['forbidden']
  assert.equal(choose({ candidates: [f.candidate, bad] }).selected.armId, armId(f.candidate))
})
test('historical best uses compatible train outcomes including baseline selections', t => {
  const f = choices(t)
  const decision = selectStrategy({ ...f.args, method: { kind: 'fixed', armId: armId(f.b) } })
  f.bank.beginAttempt({ attemptId: 'old', request: f.request, strategy: f.b.strategy, selection: { selector: decision } })
  f.bank.cancelAttempt('old', 'fixture')
  const snapshot = createSelectorSnapshot(f.bank, { trainingTaskIds: ['train'], cutoff: '2099-01-01T00:00:00.000Z' })
  assert.equal(snapshot.records[0].armId, armId(f.b))
  const result = selectStrategy({ ...f.args, request: { ...f.request, taskId: 'heldout' }, snapshot,
    selectedAt: '2099-01-02T00:00:00.000Z', method: { kind: 'historical-best' } })
  assert.equal(result.selected.armId, armId(f.b), 'observed mean is used; unseen arm is not fabricated as better')
  assert.equal(result.scores.find(s => s.armId === armId(f.b)).score, -1)
})
test('unknown method, invalid seed and unavailable fixed arm reject or abstain', t => {
  const f = choices(t)
  assert.throws(() => selectStrategy({ ...f.args, method: { kind: 'invented' } }), /method/)
  assert.throws(() => selectStrategy({ ...f.args, method: { kind: 'random', seed: -1 } }), /seed/)
  assert.equal(selectStrategy({ ...f.args, method: { kind: 'fixed', armId: 'absent' } }).selected, null)
})
