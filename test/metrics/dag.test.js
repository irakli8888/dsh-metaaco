import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StrategyBank } from '../../src/bank/index.js'
import { MetricsCollector } from '../../src/metrics/index.js'
import * as api from '../../src/adapters/harness/dag-metrics.js'

function fixture(t, { badRoute = false, failed = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dag-metrics-'))
  const bank = new StrategyBank({ dataDir: dir })
  t.after(() => { bank.close(); rmSync(dir, { recursive: true, force: true }) })
  const strategy = bank.register({ schemaVersion: 1, strategyId: 'fixture', version: 1, provenance: {},
    workflow: { name: 'fixture', description: 'test', stages: [{ title: 'work', agents: [{ id: 'coder', prompt: 'code' }] }] } })
  bank.beginAttempt({ attemptId: 'a', strategy, selection: {}, request: { schemaVersion: 1, taskId: 'a',
    description: 'test', repo: 'fixture', baseCommit: 'base', testSpec: {}, provenance: {} } })
  const collector = new MetricsCollector({ bank, attemptId: 'a' }), listeners = new Map()
  const emit = (type, ...args) => { for (const cb of listeners.get(type) ?? []) cb(...args) }
  let started = 0, disposed = 0
  const ctx = { on(type, callback) {
    if (!listeners.has(type)) listeners.set(type, new Set())
    listeners.get(type).add(callback)
    return () => listeners.get(type).delete(callback)
  }, workflowEngine: { start(req) {
    started++
    const id = req.args.taskId, run = { id: `run-${id}` }, info = { seq: 1, childId: `child-${id}`, label: id }
    const data = { usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 12 } }
    const event = { seq: 1, type: failed ? 'assistant/attempt' : 'assistant/message', data }
    // Early own usage; unrelated malformed data must never invoke the route resolver.
    emit('session/event', { id: 'foreign' }, { seq: -1, type: 'assistant/message', data: {} })
    emit('session/event', { id: info.childId }, event)
    emit('workflow/agent-start', run, info)
    return { ...run, result: Promise.resolve().then(() => {
      emit('session/event', { id: info.childId }, event)
      emit('workflow/agent-end', run, { ...info, outcome: failed ? 'failed' : 'completed' })
      return { stopReason: 'completed', value: failed ? null : id }
    }), cancel() {}, async dispose() { disposed++ } }
  } } }
  const plan = { version: 3, execution: 'dag', name: 'fixture', description: 'test',
    resources: { agentSlots: 2, maxArtifactBytes: 1024, maxInputBytes: 4096, timeoutMs: 5000 },
    tasks: ['one', 'two'].map(id => ({ id, prompt: id, dependsOn: [], inputs: [], slots: 1, model: null })) }
  const pricing = { schemaVersion: 1, id: 'fixture', provider: 'offline', model: 'fixture', modelRevision: 'v1',
    currency: 'USD', effectiveAt: '2026-01-01T00:00:00.000Z', source: 'synthetic-not-market-price',
    rates: { inputTokens: 1000000, outputTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0 } }
  const options = { bank, attemptId: 'a', collector, allowLlm: true, subagentProvider: 'offline',
    routeForEvent(session) {
      assert.notEqual(session.id, 'foreign')
      if (badRoute) throw new Error('pricing lookup failed')
      return { provider: 'offline', model: 'fixture', modelRevision: 'v1', pricing }
    } }
  return { ctx, plan, options, collector, bank, listeners, started: () => started, disposed: () => disposed }
}

test('multi-run DAG observation scopes events, deduplicates settlements and retains partial cost', async t => {
  assert.equal(typeof api.runMeasuredDag, 'function')
  const f = fixture(t)
  await api.runMeasuredDag(f.ctx, {}, f.plan, f.options)
  f.collector.finish('completed')
  const metrics = f.collector.snapshot()
  assert.equal(metrics.measured.observedCallCount, 2)
  assert.equal(metrics.measured.knownUsage.inputTokens, 20)
  assert.equal(metrics.measured.usage.inputTokens, null)
  assert.equal(metrics.calculated.costs[0].knownMicrounits, 24)
  assert.equal(metrics.calculated.costs[0].microunits, null)
  assert.equal(metrics.measured.spans.agent.count, 2)
  assert.equal(f.disposed(), 2)
  assert.ok([...f.listeners.values()].every(set => set.size === 0))
})

test('failed DAG still records observed spend without finishing the caller metrics session', async t => {
  const f = fixture(t, { failed: true })
  await assert.rejects(api.runMeasuredDag(f.ctx, {}, f.plan, f.options), e => e.report.status === 'failed')
  assert.equal(f.collector.snapshot().measured.observedCallCount, 2)
  f.collector.finish('failed')
  assert.equal(f.collector.snapshot().calls[0].status, 'failed')
})

test('observation errors cancel DAG, surface the cause and release listeners', async t => {
  const f = fixture(t, { badRoute: true })
  await assert.rejects(api.runMeasuredDag(f.ctx, {}, f.plan, f.options), /observation failed/)
  assert.equal(f.disposed(), f.started())
  assert.ok([...f.listeners.values()].every(set => set.size === 0))
  f.collector.finish('failed')
})

test('consent and pre-abort prevent engine and observer work', async t => {
  const f = fixture(t)
  await assert.rejects(api.runMeasuredDag(f.ctx, {}, f.plan, { ...f.options, allowLlm: false }), /allowLlm/)
  await assert.rejects(api.runMeasuredDag(f.ctx, {}, f.plan, { ...f.options, signal: AbortSignal.abort() }), /abort/i)
  assert.equal(f.started(), 0)
  assert.equal(f.listeners.size, 0)
})

test('collector from another attempt is rejected before DAG dispatch', async t => {
  const f = fixture(t)
  const original = f.bank.getAttempt('a')
  f.bank.beginAttempt({ attemptId: 'other', request: original.request, strategy: original.strategy, selection: {} })
  const other = new MetricsCollector({ bank: f.bank, attemptId: 'other' })
  await assert.rejects(api.runMeasuredDag(f.ctx, {}, f.plan, { ...f.options, collector: other }), /attempt/i)
  assert.equal(f.started(), 0)
})
