import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixture, price } from '../fixtures/adaptive.js'
import { MetricsCollector, BudgetController } from '../../src/metrics/index.js'
import { createBudgetedAdapter } from '../../src/adapters/harness/budget.js'
const consume = async stream => { const chunks = []; for await (const c of stream) chunks.push(c); return chunks }
function setup(t, { fail = false } = {}) {
  const f = fixture(t)
  f.bank.beginAttempt({ attemptId: 'a', request: f.request, strategy: f.candidate.strategy, selection: {} })
  const collector = new MetricsCollector({ bank: f.bank, attemptId: 'a' })
  const budget = new BudgetController({ bank: f.bank, budgetId: 'b', currency: 'USD', limitMicrounits: 10 })
  let calls = 0
  const raw = { async prepareCall() { return { model: { provider: 'offline', id: 'm', name: 'm' }, stream: options => this.stream(options) } },
    async *stream() { calls++; yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }; if (fail) throw new Error('wire failed'); yield { type: 'finish', reason: { kind: 'stop' } } } }
  const args = { collector, budget, attemptId: 'a', allowLlm: true, models: ['offline/m'], tools: [], quote: () => ({ pricing: price, upperBoundMicrounits: 6 }) }
  return { ...f, collector, budget, raw, args, calls: () => calls }
}
test('adapter reserves before stream and prepared dispatch; settlements release unused capacity', async t => {
  const f = setup(t), guarded = createBudgetedAdapter(f.raw, f.args), options = { provider: 'offline', model: 'm', messages: [] }
  await consume(guarded.stream(options))
  const prepared = await guarded.prepareCall('offline', 'm')
  await consume(prepared.stream(options))
  assert.equal(f.calls(), 2); assert.equal(f.budget.snapshot().spentMicrounits, 6)
  await assert.rejects(consume(guarded.stream(options)), /Budget/)
  assert.equal(f.calls(), 2); assert.equal(f.collector.snapshot().measured.observedCallCount, 2)
})
test('failed and abandoned streams keep the reservation and preserve partial usage', async t => {
  const f = setup(t, { fail: true }), guarded = createBudgetedAdapter(f.raw, f.args)
  await assert.rejects(consume(guarded.stream({ provider: 'offline', model: 'm' })), /wire failed/)
  assert.equal(f.budget.snapshot().heldMicrounits, 6)
  assert.equal(f.collector.snapshot().measured.knownUsage.inputTokens, 2)
  await assert.rejects(consume(guarded.stream({ provider: 'offline', model: 'm' })), /Budget/)
  assert.equal(f.calls(), 1)
})
test('consent, unknown route, tools and cancellation reject before underlying I/O', async t => {
  const f = setup(t)
  for (const [args, options] of [[{ allowLlm: false }, { provider: 'offline', model: 'm' }], [{}, { provider: 'other', model: 'm' }], [{}, { provider: 'offline', model: 'm', tools: [{ name: 'shell' }] }], [{ signal: AbortSignal.abort() }, { provider: 'offline', model: 'm' }]]) {
    await assert.rejects(consume(createBudgetedAdapter(f.raw, { ...f.args, ...args }).stream(options)))
  }
  assert.equal(f.calls(), 0); assert.equal(f.budget.snapshot().reservations.length, 0)
})
test('terminal error chunks retain funds and cannot masquerade as a complete bill', async t => {
  const f = setup(t)
  f.raw.stream = async function* () { yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }; yield { type: 'finish', reason: { kind: 'error', failure: { message: 'wire' } } } }
  await consume(createBudgetedAdapter(f.raw, f.args).stream({ provider: 'offline', model: 'm' }))
  assert.equal(f.budget.snapshot().heldMicrounits, 6)
  assert.equal(f.collector.snapshot().calls[0].status, 'failed')
})
test('abandoning iteration retains its reserve even after observing usage', async t => {
  const f = setup(t)
  for await (const _ of createBudgetedAdapter(f.raw, f.args).stream({ provider: 'offline', model: 'm' })) break
  assert.equal(f.budget.snapshot().heldMicrounits, 6)
  assert.equal(f.collector.snapshot().calls[0].status, 'interrupted')
})
test('concurrent requests cannot spend the same remaining funds', async t => {
  const f = setup(t)
  let release
  const waiting = new Promise(r => { release = r })
  f.raw.stream = async function* () { await waiting; yield { type: 'finish', reason: { kind: 'stop' } } }
  const adapter = createBudgetedAdapter(f.raw, f.args), options = { provider: 'offline', model: 'm' }
  const first = consume(adapter.stream(options))
  await assert.rejects(consume(adapter.stream(options)), /Budget/)
  release(); await first
  assert.equal(f.budget.snapshot().heldMicrounits, 6, 'missing usage leaves funds reserved')
})
