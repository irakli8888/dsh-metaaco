import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { StrategyBank } from '../../src/bank/index.js'
import { MetricsCollector, BudgetController, calculateCost, normalizeUsage } from '../../src/metrics/index.js'

const price = () => ({ schemaVersion: 1, id: 'offline-v1', provider: 'offline', model: 'fixture', modelRevision: 'v1',
  currency: 'USD', effectiveAt: '2026-10-25T00:00:00.000Z', source: 'synthetic-test-not-a-market-price',
  rates: { inputTokens: 1000000, outputTokens: 2000000, cacheReadTokens: 100000, cacheWriteTokens: 500000 } })
const usage = () => ({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 10, cacheWriteTokens: 2, reasoningTokens: 2, totalTokens: 27 })
const call = (callId = 'call-1') => ({ callId, provider: 'offline', model: 'fixture', modelRevision: 'v1', requestId: null,
  status: 'completed', kind: 'agent', latencyMs: null, usage: usage(), pricing: price(),
  billing: null, source: 'synthetic-offline-call' })

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'metrics-'))
  const bank = new StrategyBank({ dataDir: dir })
  t.after(() => { bank.close(); rmSync(dir, { recursive: true, force: true }) })
  const strategy = bank.register({ schemaVersion: 1, strategyId: 'fixed', version: 1, provenance: {},
    workflow: { name: 'fixed', description: 'test', stages: [{ title: 'test', agents: [{ id: 'coder', prompt: 'test' }] }] } })
  for (const id of ['a', 'b']) bank.beginAttempt({ attemptId: id, strategy, selection: {}, request: {
    schemaVersion: 1, taskId: id, repo: 'fixture', baseCommit: 'base', description: 'test', testSpec: {}, provenance: {},
  } })
  let time = 0
  const clock = { now: () => time, utc: () => '2026-10-25T00:00:00.000Z' }
  return { bank, dir, clock, setTime: n => { time = n }, collector: () => new MetricsCollector({ bank, attemptId: 'a',
    estimates: { wallTimeMs: 99 }, clock, clockId: 'test-clock' }) }
}

test('cost uses disjoint cache categories, includes reasoning only once and rounds exactly', () => {
  assert.deepEqual(calculateCost(usage(), price()), { currency: 'USD', microunits: 22, reason: null })
  const p = price(); p.rates = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1 }
  assert.equal(calculateCost({ ...usage(), inputTokens: 1, totalTokens: 18 }, p).microunits, 1)
  assert.equal(calculateCost(null, price()).microunits, null)
  assert.equal(normalizeUsage({ inputTokens: 1, outputTokens: 2 }).cacheReadTokens, null)
  assert.throws(() => normalizeUsage({ inputTokens: -1 }))
  assert.throws(() => normalizeUsage({ outputTokens: 2, reasoningTokens: 3 }))
})

test('wall time differs from parallel agent sums; duplicate events cannot inflate totals', t => {
  const f = fixture(t), m = f.collector()
  m.startSpan('analysis', 'analysis')
  f.setTime(10); m.endSpan('analysis', 'completed')
  m.startSpan('agent-a', 'agent'); m.startSpan('agent-b', 'agent')
  m.recordCall(call())
  f.setTime(20); m.recordCall(call())
  m.endSpan('agent-a', 'completed'); m.endSpan('agent-b', 'failed')
  m.recordCall({ ...call('retry'), status: 'failed', kind: 'retry' })
  f.setTime(30); m.finish('failed', { coverageComplete: true })
  const result = m.snapshot()
  assert.equal(result.measured.wallTimeMs, 30)
  assert.equal(result.measured.spans.agent.sumMs, 20)
  assert.equal(result.measured.spans.agent.unionMs, 10)
  assert.equal(result.measured.usage.inputTokens, 20)
  assert.equal(result.measured.observedCallCount, 2)
  assert.equal(result.calculated.costs[0].microunits, 44)
  assert.equal(result.estimates.wallTimeMs, 99)
  assert.deepEqual(f.collector().snapshot(), result, 'persistent replay reproduces the snapshot')
  assert.throws(() => m.recordCall({ ...call(), usage: { ...usage(), inputTokens: 11, totalTokens: 28 } }), /conflict/)
})

test('missing usage or price remains unknown with known subtotals and a reason', t => {
  const f = fixture(t), m = f.collector()
  m.recordCall(call())
  m.recordCall({ ...call('unknown'), usage: null, pricing: null })
  m.finish('cancelled', { coverageComplete: false })
  const result = m.snapshot()
  assert.equal(result.measured.usage.inputTokens, null)
  assert.equal(result.measured.knownUsage.inputTokens, 10)
  assert.equal(result.calculated.costs[0].microunits, null)
  assert.equal(result.calculated.costs[0].knownMicrounits, 22)
  assert.ok(result.unavailable.length)
  assert.equal(result.providerReportedBilling.length, 0)
})

test('clock resets cannot fabricate durations and an open span is not silently completed', t => {
  const f = fixture(t), m = f.collector()
  m.startSpan('open', 'queue')
  const restarted = new MetricsCollector({ bank: f.bank, attemptId: 'a', clock: f.clock, clockId: 'new-process', estimates: { wallTimeMs: 99 } })
  f.setTime(10); restarted.endSpan('open', 'cancelled'); restarted.finish('interrupted', { coverageComplete: false })
  assert.equal(restarted.snapshot().measured.wallTimeMs, null)
  assert.equal(restarted.snapshot().measured.spans.queue.sumMs, null)
  assert.ok(restarted.snapshot().unavailable.some(reason => reason.includes('clock')))
})

test('late provider billing is an append-only correction, not a rewrite of measured cost', t => {
  const f = fixture(t), m = f.collector()
  m.recordCall(call()); m.finish('completed', { coverageComplete: true })
  const outcome = m.snapshot()
  f.bank.finalizeAttempt('a', { status: 'inconclusive', requiredTests: [], provenance: {} }, outcome)
  m.recordBilling('invoice-1', 'call-1', { currency: 'USD', microunits: 25, source: 'synthetic-invoice' })
  m.recordBilling('invoice-1', 'call-1', { currency: 'USD', microunits: 25, source: 'synthetic-invoice' })
  assert.equal(m.snapshot().providerReportedBilling[0].microunits, 25)
  assert.equal(m.snapshot().calculated.costs[0].microunits, 22)
  assert.deepEqual(f.bank.getAttempt('a').outcome, outcome)
  assert.throws(() => m.recordBilling('invoice-1', 'call-1', { currency: 'USD', microunits: 26, source: 'synthetic-invoice' }), /conflict/)
})

test('atomic shared budget holds concurrent reservations and reconciles actual costs', t => {
  const f = fixture(t), b = new BudgetController({ bank: f.bank, budgetId: 'shared', currency: 'USD', limitMicrounits: 100 })
  assert.equal(b.reserve({ reservationId: 'one', attemptId: 'a', upperBoundMicrounits: 60 }).created, true)
  assert.throws(() => b.reserve({ reservationId: 'two', attemptId: 'b', upperBoundMicrounits: 60 }), /budget/i)
  b.settle({ reservationId: 'one', settlementId: 'usage-1', actualMicrounits: 20, source: 'calculated' })
  b.reserve({ reservationId: 'two', attemptId: 'b', upperBoundMicrounits: 60 })
  assert.equal(b.snapshot().remainingMicrounits, 20)
  b.settle({ reservationId: 'two', settlementId: 'unknown-2', actualMicrounits: null, source: 'usage unavailable' })
  assert.equal(b.snapshot().heldMicrounits, 60)
  b.settle({ reservationId: 'two', settlementId: 'invoice-2', actualMicrounits: 90, source: 'provider billing' })
  assert.equal(b.snapshot().violated, true)
  assert.throws(() => b.reserve({ reservationId: 'three', attemptId: 'a', upperBoundMicrounits: 0 }), /budget/i)
})

test('a budgeted operation needs explicit consent and cannot execute twice on an idempotent reservation', async t => {
  const f = fixture(t), b = new BudgetController({ bank: f.bank, budgetId: 'run', currency: 'USD', limitMicrounits: 100 })
  let starts = 0
  const options = { reservationId: 'call', attemptId: 'a', upperBoundMicrounits: 30 }
  const run = async () => { starts++; return { cost: 10 } }
  await assert.rejects(b.run(options, run, result => result.cost), /allowLlm/)
  assert.equal(starts, 0)
  await b.run({ ...options, allowLlm: true }, run, result => result.cost)
  await assert.rejects(b.run({ ...options, allowLlm: true }, run, result => result.cost), /already/)
  assert.equal(starts, 1)
  await assert.rejects(b.run({ ...options, reservationId: 'unknown', allowLlm: true }, async () => { throw Error('connection lost') }, () => 0))
  assert.equal(b.snapshot().heldMicrounits, 30, 'a failed request may still have been billed')
})

test('independent processes cannot reserve the same remaining money', async t => {
  const f = fixture(t)
  new BudgetController({ bank: f.bank, budgetId: 'parallel', currency: 'USD', limitMicrounits: 100 })
  const module = new URL('../../src/bank/index.js', import.meta.url).href
  const results = await Promise.all([0, 1, 2].map(i => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import {StrategyBank} from ${JSON.stringify(module)};
      const b=new StrategyBank({dataDir:${JSON.stringify(f.dir)}});
      try { b.reserveBudget({budgetId:'parallel',reservationId:'r${i}',attemptId:'a',upperBoundMicrounits:60}); console.log('reserved'); }
      catch(e) {console.log('rejected');} finally {b.close();}
    `])
    let out = '', err = ''; child.stdout.on('data', d => { out += d }); child.stderr.on('data', d => { err += d })
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve(out.trim()) : reject(Error(err)))
  })))
  assert.equal(results.filter(r => r === 'reserved').length, 1)
})

test('a breached per-call bound stays recorded and blocks later dispatch even after a lower correction', async t => {
  const f = fixture(t), b = new BudgetController({ bank: f.bank, budgetId: 'bound', currency: 'USD', limitMicrounits: 200 })
  await assert.rejects(b.run({ reservationId: 'breach', attemptId: 'a', upperBoundMicrounits: 10, allowLlm: true },
    async () => ({ cost: 100 }), r => r.cost), /bound|budget/i)
  assert.equal(b.snapshot().spentMicrounits, 100)
  b.settle({ reservationId: 'breach', settlementId: 'lower-correction', actualMicrounits: 5, source: 'corrected invoice' })
  assert.equal(b.snapshot().violated, true)
  assert.throws(() => b.reserve({ reservationId: 'later', attemptId: 'a', upperBoundMicrounits: 1 }), /budget/i)
})

test('contradictory provider totals are rejected rather than learned as measured usage', () => {
  assert.throws(() => normalizeUsage({ ...usage(), totalTokens: 999 }), /total/i)
})

test('currencies stay separate, pricing revisions are pinned, and overflow is explicit', t => {
  const f = fixture(t), m = f.collector()
  m.recordCall(call())
  m.recordCall({ ...call('eur'), pricing: { ...price(), currency: 'EUR' } })
  assert.throws(() => m.recordCall({ ...call('wrong-route'), modelRevision: 'different' }), /route/)
  const expensive = price(); expensive.rates.inputTokens = Number.MAX_SAFE_INTEGER
  assert.throws(() => calculateCost({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0 }, expensive), /safe integer/)
  m.finish('completed', { coverageComplete: true })
  assert.deepEqual(m.snapshot().calculated.costs.map(c => [c.currency, c.microunits]), [['EUR', 22], ['USD', 22]])
  const persisted = f.bank.exportJsonl()
  assert.equal(f.bank.exportJsonl(), persisted)
})

test('zero-price categories can be priced without inventing unknown usage counts', () => {
  const free = price(); free.rates = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  assert.equal(calculateCost(null, free).microunits, 0)
  assert.equal(normalizeUsage(null).inputTokens, null)
})

test('reservations survive reopening and can be reconciled after the attempt terminates', async t => {
  const f = fixture(t), b = new BudgetController({ bank: f.bank, budgetId: 'durable', currency: 'USD', limitMicrounits: 100 })
  b.reserve({ reservationId: 'unconfirmed', attemptId: 'a', upperBoundMicrounits: 95 })
  let dispatched = false
  await assert.rejects(b.run({ reservationId: 'blocked', attemptId: 'b', upperBoundMicrounits: 10, allowLlm: true },
    async () => { dispatched = true }, () => 0), /budget/i)
  assert.equal(dispatched, false)
  assert.throws(() => b.reserve({ reservationId: 'unbounded', attemptId: 'b', upperBoundMicrounits: null }))
  f.bank.finalizeAttempt('a', { status: 'inconclusive', requiredTests: [], provenance: {} }, { measured: {}, estimates: {} })
  const reopened = new StrategyBank({ dataDir: f.dir })
  try {
    const restored = new BudgetController({ bank: reopened, budgetId: 'durable', currency: 'USD', limitMicrounits: 100 })
    assert.equal(restored.snapshot().heldMicrounits, 95)
    restored.settle({ reservationId: 'unconfirmed', settlementId: 'late', actualMicrounits: 30, source: 'offline invoice' })
    assert.equal(b.snapshot().remainingMicrounits, 70)
    assert.ok(reopened.exportJsonl().includes('budgetSettlement'))
    assert.throws(() => new BudgetController({ bank: reopened, budgetId: 'durable', currency: 'USD', limitMicrounits: 200 }), /immutable/)
    assert.equal(f.bank.getAttempt('a').state, 'inconclusive')
  } finally { reopened.close() }
})
