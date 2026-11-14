import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixture, snapshot, price } from '../fixtures/adaptive.js'
import { runAdaptiveAttempt } from '../../src/orchestration/index.js'
function runtime(starts, value = 'a+b') {
  return async ({ guardAdapter, signal }) => {
    const adapter = guardAdapter({ async *stream() { yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }; yield { type: 'finish', reason: { kind: 'stop' } } } }, () => ({ pricing: price, upperBoundMicrounits: 6 }))
    return { parent: { id: 'parent' }, subagentProvider: 'offline', async dispose() {}, ctx: { workflowEngine: { start(req) {
      starts.push(req.args.taskId)
      const result = (async () => { for await (const _ of adapter.stream({ ...req.args.model, signal })) {} return { stopReason: 'completed', value: JSON.stringify(snapshot(req.args.taskId, value)) } })()
      return { id: req.args.taskId, result, cancel() {}, async dispose() {} }
    } } } }
  }
}
const options = f => ({ bank: f.bank, attemptId: 'a', request: f.request, feedback: f.feedback, candidates: [f.candidate], bindings: [f.binding], baseSnapshot: f.base, allowLlm: true })
test('whole attempt independently verifies TDD, stores metrics and advances only training feedback', async t => {
  const f = fixture(t), starts = []
  const r = await runAdaptiveAttempt({ ...options(f), createRuntime: runtime(starts) })
  assert.equal(r.attempt.state, 'succeeded'); assert.deepEqual(starts, ['green', 'refactor'])
  assert.equal(r.attempt.evaluation.provenance.source, 'independent-node-evaluator')
  assert.equal(r.attempt.outcome.measured.observedCallCount, 2)
  assert.notEqual(r.feedback.sha256, f.feedback.sha256)
  assert.equal(r.attempt.outcome.measured.coverageComplete, false)
})
test('failing GREEN blocks REFACTOR and finalizes a failed attempt with expenses', async t => {
  const f = fixture(t), starts = []
  const r = await runAdaptiveAttempt({ ...options(f), createRuntime: runtime(starts, '0') })
  assert.equal(r.attempt.state, 'failed'); assert.deepEqual(starts, ['green'])
  assert.equal(r.attempt.outcome.measured.knownUsage.inputTokens, 2)
})
test('invalid RED stops before runtime creation and held-out outcomes never update feedback', async t => {
  const f = fixture(t), starts = []
  const r = await runAdaptiveAttempt({ ...options(f), request: { ...f.request, taskId: 'heldout' }, baseSnapshot: snapshot('base'), createRuntime: runtime(starts) })
  assert.equal(r.attempt.state, 'failed'); assert.deepEqual(starts, []); assert.deepEqual(r.feedback, f.feedback)
})
test('consent and binding mismatch fail before creating an attempt', async t => {
  const f = fixture(t)
  await assert.rejects(runAdaptiveAttempt({ ...options(f), allowLlm: false, createRuntime: runtime([]) }), /allowLlm/)
  const binding = structuredClone(f.binding); binding.plan.tasks[0].model.model = 'forbidden'
  await assert.rejects(runAdaptiveAttempt({ ...options(f), bindings: [binding], createRuntime: runtime([]) }), /route|model/i)
  assert.equal(f.bank.getAttempt('a'), null)
})
test('cancellation during runtime setup preserves evidence and disposes before terminal state', async t => {
  const f = fixture(t), controller = new AbortController()
  let disposed = false
  const r = await runAdaptiveAttempt({ ...options(f), signal: controller.signal, createRuntime: async () => {
    controller.abort(new Error('user cancelled'))
    return { async dispose() { disposed = true } }
  } })
  assert.equal(r.attempt.state, 'cancelled'); assert.equal(disposed, true)
  assert.ok(f.bank.getEvents('a').some(e => e.eventId === 'metrics/finish'))
})
test('cleanup failures never reuse earlier successful evaluation', async t => {
  const f = fixture(t)
  const factory = runtime([])
  const r = await runAdaptiveAttempt({ ...options(f), createRuntime: async args => {
    const rt = await factory(args); rt.dispose = async () => { throw new Error('dispose failed') }; return rt
  } })
  assert.equal(r.attempt.state, 'inconclusive')
  assert.equal(r.attempt.evaluation.provenance.source, 'orchestration-v1')
})
test('repeat invocation cannot dispatch or modify a terminal attempt', async t => {
  const f = fixture(t), starts = [], args = { ...options(f), createRuntime: runtime(starts) }
  await runAdaptiveAttempt(args)
  await assert.rejects(runAdaptiveAttempt(args), /already|replay/)
  assert.deepEqual(starts, ['green', 'refactor'])
})
test('unverified planner output is rejected before any attempt or dispatch', async t => {
  const f = fixture(t)
  await assert.rejects(runAdaptiveAttempt({ ...options(f), planning: { result: {}, problem: {} }, createRuntime: runtime([]) }), /problem|planner|fields/i)
  assert.equal(f.bank.getAttempt('a'), null)
})
test('dispatch failure is a failed attempt, not successful or missing history', async t => {
  const f = fixture(t)
  const r = await runAdaptiveAttempt({ ...options(f), createRuntime: async () => ({ parent: {}, ctx: { workflowEngine: { start() { throw new Error('dispatch unavailable') } } }, async dispose() {} }) })
  assert.equal(r.attempt.state, 'failed')
  assert.equal(r.execution.status, 'failed')
})
test('deadline before dispatch preserves timeout as a separate outcome', async t => {
  const f = fixture(t)
  const { advanceFeedback } = await import('../../src/feedback/index.js')
  const feedback = advanceFeedback(f.bank, { manifest: f.manifest, policy: { ...f.policy, maxWallTimeMs: 1 }, cutoff: '2000-01-01T00:00:00.000Z' })
  const candidate = structuredClone(f.candidate); candidate.estimates.wallTimeMs = 1
  const starts = []
  const r = await runAdaptiveAttempt({ ...options(f), feedback, candidates: [candidate], createRuntime: runtime(starts) })
  assert.equal(r.attempt.state, 'timeout'); assert.deepEqual(starts, [])
  assert.ok(r.attempt.outcome.measured.wallTimeMs >= 1)
})
test('outer experiment deadline remains timeout in the attempt history', async t => {
  const f = fixture(t), controller = new AbortController()
  const r = await runAdaptiveAttempt({ ...options(f), signal: controller.signal, createRuntime: async () => {
    controller.abort(new DOMException('Experiment deadline', 'TimeoutError'))
    return { async dispose() {} }
  } })
  assert.equal(r.attempt.state, 'timeout')
})

test('two attempts exhaust the same series budget', async t => {
  const f = fixture(t)
  const seriesBudget = { budgetId: 'series/test', currency: 'USD', limitMicrounits: 12 }
  const first = await runAdaptiveAttempt({ ...options(f), seriesBudget, createRuntime: runtime([]) })
  assert.equal(first.attempt.state, 'succeeded')
  const second = await runAdaptiveAttempt({ ...options(f), attemptId: 'b', seriesBudget, createRuntime: runtime([]) })
  assert.notEqual(second.attempt.state, 'succeeded')
  assert.equal(f.bank.getBudget('series/test').spentMicrounits, 9)
})
