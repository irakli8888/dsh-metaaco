import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StrategyBank } from '../../src/bank/index.js'
import * as api from '../../src/execution/index.js'

const task = (id, dependsOn = [], inputs = []) => ({ id, prompt: `Task ${id}`, dependsOn, inputs, slots: 1, model: null })
const plan = () => ({ version: 3, execution: 'dag', name: 'fixture', description: 'offline DAG',
  resources: { agentSlots: 2, maxArtifactBytes: 1024, maxInputBytes: 4096, timeoutMs: 5000 },
  tasks: [task('a'), task('b'), task('c', ['a'], [{ name: 'source', taskId: 'a' }]), task('join', ['b', 'c'])] })
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function fixture(t, execute = async req => req.args.taskId) {
  const dir = mkdtempSync(join(tmpdir(), 'dag-'))
  const bank = new StrategyBank({ dataDir: dir })
  t.after(() => { bank.close(); rmSync(dir, { recursive: true, force: true }) })
  const strategy = bank.register({ schemaVersion: 1, strategyId: 'fixed', version: 1, provenance: {},
    workflow: { name: 'fixture', description: 'test', stages: [{ title: 'code', agents: [{ id: 'coder', prompt: 'code' }] }] } })
  bank.beginAttempt({ attemptId: 'run', strategy, selection: {}, request: { schemaVersion: 1,
    taskId: 'task', description: 'fixture', repo: 'fixture', baseCommit: 'base', testSpec: {}, provenance: {} } })
  const starts = [], disposed = [], cancelled = []
  let activeSlots = 0, maxSlots = 0
  const ctx = { workflowEngine: { start(req) {
    starts.push(req)
    activeSlots += req.args.slots; maxSlots = Math.max(maxSlots, activeSlots)
    const stop = deferred()
    const result = Promise.race([Promise.resolve().then(() => execute(req)).then(value => ({ stopReason: 'completed', value, agentsStarted: 1 })), stop.promise])
    return { id: `harness-${req.args.taskId}`, result,
      cancel() { cancelled.push(req.args.taskId); stop.resolve({ stopReason: 'cancelled', value: null, agentsStarted: 1 }) },
      async dispose() { disposed.push(req.args.taskId); activeSlots -= req.args.slots },
    }
  } } }
  const run = (p = plan(), options = {}) => api.runDag(ctx, { id: 'parent' }, p,
    { bank, attemptId: 'run', allowLlm: true, subagentProvider: 'offline', ...options })
  return { bank, ctx, starts, disposed, cancelled, run, maxSlots: () => maxSlots }
}

test('v3 preview validates cycles, dependencies, bindings and resource demands without execution', () => {
  assert.equal(typeof api.previewDag, 'function')
  const p = plan(), preview = api.previewDag(p)
  assert.equal(preview.preview, true); assert.equal(preview.tasks.length, 4)
  p.tasks[0].dependsOn = ['c']
  assert.throws(() => api.previewDag(p), /cycle/i)
  const bad = plan(); bad.tasks[2].inputs[0].taskId = 'b'
  assert.throws(() => api.previewDag(bad), /dependency/i)
  const oversized = plan(); oversized.tasks[0].slots = 3
  assert.throws(() => api.previewDag(oversized), /slots/i)
  assert.throws(() => api.previewDag({ ...plan(), script: 'untrusted' }), /plan/i)
})

test('ready successors start before unrelated slow roots finish, with explicit artifacts', async t => {
  const slow = deferred(), successor = deferred()
  const f = fixture(t, async req => {
    if (req.args.taskId === 'b') return slow.promise
    if (req.args.taskId === 'c') {
      const input = JSON.parse(req.args.prompt)
      assert.equal(input.artifacts[0].content, 'a')
      assert.equal(input.artifacts[0].producer, 'a')
      assert.equal(input.artifacts[0].name, 'source')
      assert.match(input.artifacts[0].sha256, /^[a-f0-9]{64}$/)
      successor.resolve()
    }
    return req.args.taskId
  })
  const execution = f.run()
  await successor.promise
  assert.deepEqual(f.starts.map(r => r.args.taskId), ['a', 'b', 'c'])
  slow.resolve('b')
  const result = await execution
  assert.equal(result.status, 'completed')
  assert.equal(result.quality, 'inconclusive')
  assert.equal(f.bank.getAttempt('run').state, 'running', 'only evaluator can finalize quality')
  assert.ok(f.maxSlots() <= 2)
  assert.equal(f.disposed.length, 4)
  assert.equal(f.bank.getArtifact(result.tasks.find(n => n.id === 'c').artifact).toString(), 'c')
  assert.ok(f.bank.getEvents('run').some(e => e.eventId === 'dag/finish'))
})

test('failed node blocks descendants while unrelated work completes and evidence survives', async t => {
  const f = fixture(t, req => req.args.taskId === 'a' ? null : 'independent')
  await assert.rejects(f.run(), error => {
    assert.equal(error.report.status, 'failed')
    assert.equal(error.report.tasks.find(n => n.id === 'c').state, 'blocked')
    assert.equal(error.report.tasks.find(n => n.id === 'b').state, 'completed')
    assert.equal(error.report.tasks.find(n => n.id === 'a').runId, 'harness-a')
    return true
  })
  assert.deepEqual(f.starts.map(r => r.args.taskId), ['a', 'b'])
  assert.equal(f.disposed.length, 2)
  assert.ok(f.bank.getEvents('run').some(e => e.payload.state === 'failed'))
})

test('consent, pre-abort and replay protection prevent dispatch', async t => {
  const f = fixture(t)
  await assert.rejects(f.run(plan(), { allowLlm: false }), /allowLlm/)
  await assert.rejects(f.run(plan(), { signal: AbortSignal.abort() }), /abort/i)
  assert.equal(f.starts.length, 0)
  await f.run()
  await assert.rejects(f.run(), /already|conflict/i)
  assert.equal(f.starts.length, 4)
})

test('cancellation drains active runs, disposes handles and never dispatches pending work', async t => {
  const entered = deferred(), never = deferred(), controller = new AbortController()
  const f = fixture(t, () => { entered.resolve(); return never.promise })
  const execution = f.run(plan(), { signal: controller.signal })
  await entered.promise; controller.abort()
  await assert.rejects(execution, e => e.report.status === 'cancelled')
  assert.equal(f.starts.length, 2); assert.equal(f.disposed.length, 2)
  assert.equal(f.cancelled.length, 2)
})

test('deadline cancels work and stores timeout rather than success', async t => {
  const f = fixture(t, () => new Promise(() => {}))
  const p = plan(); p.resources.timeoutMs = 20
  await assert.rejects(f.run(p), e => e.report.status === 'timeout')
  assert.equal(f.disposed.length, 2)
})

test('weighted slots, model overrides and plan snapshot are respected', async t => {
  const f = fixture(t)
  const p = plan(); p.tasks[0].slots = 2
  p.tasks[0].model = { provider: 'offline', model: 'fixture-model' }
  const execution = f.run(p)
  p.tasks[1].prompt = 'mutated'
  await execution
  assert.equal(f.maxSlots(), 2)
  assert.equal(f.starts[0].args.model.model, 'fixture-model')
  assert.equal(JSON.parse(f.starts[1].args.prompt).task, 'Task b')
  assert.ok(f.starts.every(r => r.maxTotalAgents === 1 && r.subagentProvider === 'offline'))
})

test('oversized outputs and input envelopes fail without launching dependent agents', async t => {
  const f = fixture(t, () => 'x'.repeat(1025))
  await assert.rejects(f.run(), e => e.report.tasks[0].reason.includes('artifact'))
  assert.equal(f.starts.length, 2)
  const g = fixture(t)
  const p = plan(); p.resources.maxInputBytes = 1
  await assert.rejects(g.run(p), e => e.report.status === 'failed')
  assert.equal(g.starts.length, 0)
})

test('synchronous start errors and disposal failures stop dependent dispatch', async t => {
  const f = fixture(t)
  f.ctx.workflowEngine.start = () => { throw new Error('start rejected') }
  await assert.rejects(f.run(), e => e.report.tasks[0].reason === 'start rejected')
  const g = fixture(t)
  g.ctx.workflowEngine.start = () => ({ id: 'failed-cleanup',
    result: Promise.resolve({ stopReason: 'completed', value: 'data' }),
    async dispose() { throw new Error('cleanup rejected') }, cancel() {},
  })
  await assert.rejects(g.run(), e => e.report.tasks.find(n => n.id === 'a').reason === 'cleanup rejected')
})

test('journal failure aborts and drains active siblings before returning', async t => {
  const f = fixture(t, req => req.args.taskId === 'a' ? 'a' : new Promise(() => {}))
  const append = f.bank.appendEvent.bind(f.bank)
  f.bank.appendEvent = (attemptId, eventId, event) => {
    if (eventId === 'dag/task/a/completed') throw new Error('journal failure')
    return append(attemptId, eventId, event)
  }
  await assert.rejects(f.run(), e => e.report.status === 'failed' && e.cause.message === 'journal failure')
  assert.equal(f.disposed.length, 2)
  assert.deepEqual(f.starts.map(r => r.args.taskId), ['a', 'b'])
})
