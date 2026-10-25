import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { StrategyBank } from '../../src/bank/index.js'

const provenance = { source: 'offline-test', revision: 'fixture-v1' }
const strategy = () => ({ schemaVersion: 1, strategyId: 'fixed', version: 1, provenance,
  workflow: { name: 'fixed', description: 'Offline fixture', stages: [
    { title: 'Implement', agents: [{ id: 'coder', prompt: 'Implement task' }] },
  ] } })
const request = () => ({ schemaVersion: 1, taskId: 'task-1', description: 'Add function',
  repo: 'fixture', baseCommit: 'abc', testSpec: { command: ['node', '--test'] }, provenance })
const input = (attemptId = 'attempt-1') => ({ attemptId, request: request(),
  strategy: { strategyId: 'fixed', version: 1 }, selection: { policy: 'fixed-v1', seed: 42 } })
const evaluation = (status = 'failed') => ({ status, requiredTests: [
  { id: 'acceptance', status: status === 'success' ? 'passed' : 'failed' },
], provenance })
const outcome = { measured: { wallTimeMs: 12, inputTokens: null, cost: null },
  estimates: { wallTimeMs: 10 }, unavailable: ['usage not reported'] }

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'strategy-bank-'))
  const banks = []
  t.after(() => { for (const bank of banks) bank.close(); rmSync(dir, { recursive: true, force: true }) })
  return { dir, open: () => { const bank = new StrategyBank({ dataDir: dir }); banks.push(bank); return bank } }
}

test('strategy versions and failed attempts survive reopening; reads are isolated snapshots', t => {
  const { open } = fixture(t)
  let bank = open()
  const original = strategy()
  bank.register(original)
  original.workflow.description = 'mutated'
  assert.equal(bank.getStrategy('fixed', 1).workflow.description, 'Offline fixture')
  assert.deepEqual(bank.register(strategy()), { strategyId: 'fixed', version: 1 })
  assert.throws(() => bank.register({ ...strategy(), workflow: original.workflow }), /immutable/)
  bank.register({ ...strategy(), version: 2 })
  bank.beginAttempt(input())
  bank.finalizeAttempt('attempt-1', evaluation(), outcome)
  bank.close()
  bank = open()
  assert.equal(bank.listStrategies().length, 2)
  const attempt = bank.getAttempt('attempt-1')
  assert.equal(attempt.state, 'failed')
  assert.deepEqual(attempt.outcome, outcome)
  assert.deepEqual(attempt.request.testSpec, request().testSpec)
  attempt.outcome.measured.wallTimeMs = 99
  assert.equal(bank.getAttempt('attempt-1').outcome.measured.wallTimeMs, 12)
  assert.equal(bank.listAttempts({ state: 'failed', taskId: 'task-1' }).length, 1)
})

test('references, immutable task snapshots and terminal transitions are enforced', t => {
  const bank = fixture(t).open()
  assert.throws(() => bank.beginAttempt(input()), /strategy/i)
  bank.register(strategy())
  bank.beginAttempt(input())
  bank.beginAttempt(input('attempt-2'))
  assert.throws(() => bank.beginAttempt({ ...input('attempt-3'), request: { ...request(), baseCommit: 'other' } }), /immutable/)
  assert.equal(bank.getAttempt('attempt-3'), null)
  assert.throws(() => bank.finalizeAttempt('attempt-1', { ...evaluation('success'), requiredTests: [] }, outcome), /required/i)
  assert.throws(() => bank.finalizeAttempt('attempt-1', { ...evaluation('success'), requiredTests: [{ id: 'test', status: 'failed' }] }, outcome), /required/i)
  assert.equal(bank.getAttempt('attempt-1').state, 'running')
  bank.finalizeAttempt('attempt-1', evaluation('success'), outcome)
  assert.equal(bank.getAttempt('attempt-1').state, 'succeeded')
  bank.finalizeAttempt('attempt-1', evaluation('success'), outcome)
  assert.throws(() => bank.finalizeAttempt('attempt-1', evaluation(), outcome), /terminal/)
  assert.throws(() => bank.appendEvent('attempt-1', 'late', { kind: 'usage', payload: {} }), /terminal/)
})

test('events deduplicate identical retries and reject conflicting ids without consuming sequence', t => {
  const bank = fixture(t).open()
  bank.register(strategy()); bank.beginAttempt(input())
  const event = { kind: 'model-usage', payload: { inputTokens: 10, model: 'offline' } }
  const first = bank.appendEvent('attempt-1', 'call-1', event)
  assert.deepEqual(bank.appendEvent('attempt-1', 'call-1', event), first)
  assert.throws(() => bank.appendEvent('attempt-1', 'call-1', { ...event, payload: {} }), /conflict/)
  bank.appendEvent('attempt-1', 'call-2', event)
  assert.deepEqual(bank.getEvents('attempt-1').map(e => e.sequence), [1, 2])
  assert.equal(bank.getEvents('attempt-1')[0].payload.inputTokens, 10)
})

test('recovery is explicit and scoped so opening another connection does not interrupt live runs', t => {
  const { open } = fixture(t)
  const bank = open(); bank.register(strategy()); bank.beginAttempt(input())
  const other = open()
  assert.equal(other.getAttempt('attempt-1').state, 'running')
  other.beginAttempt(input('live'))
  assert.throws(() => other.recoverInterrupted(['attempt-1', 'missing'], 'process crashed'), /Unknown/)
  assert.equal(bank.getAttempt('attempt-1').state, 'running')
  other.recoverInterrupted(['attempt-1'], 'process crashed')
  assert.equal(bank.getAttempt('attempt-1').state, 'interrupted')
  assert.equal(bank.getAttempt('attempt-1').outcome, null)
  assert.equal(bank.getAttempt('live').state, 'running')
  assert.throws(() => bank.finalizeAttempt('attempt-1', evaluation('success'), outcome), /terminal/)
})

test('content-addressed artifacts are deduplicated, linked, verified and exported deterministically', t => {
  const { open, dir } = fixture(t)
  const bank = open(); bank.register(strategy()); bank.beginAttempt(input())
  const bytes = Buffer.from('test report\n')
  const ref = bank.putArtifact(bytes)
  assert.deepEqual(bank.putArtifact(bytes), ref)
  bank.attachArtifact('attempt-1', 'red-report', ref)
  bank.attachArtifact('attempt-1', 'red-report', ref)
  assert.deepEqual(bank.getArtifact(ref), bytes)
  assert.throws(() => bank.getArtifact({ sha256: '../escape', sizeBytes: 0 }), /artifact/i)
  const exported = bank.exportJsonl()
  assert.equal(bank.exportJsonl(), exported)
  assert.equal(open().exportJsonl(), exported)
  const records = exported.trim().split('\n').map(JSON.parse)
  assert.equal(records.filter(r => r.type === 'artifact').length, 1)
  assert.equal(records.find(r => r.type === 'attemptArtifact').value.name, 'red-report')
  writeFileSync(join(dir, 'artifacts', ref.sha256), 'corrupt')
  assert.throws(() => bank.getArtifact(ref), /integrity/i)
  assert.throws(() => bank.putArtifact(bytes), /integrity/i)
})

test('invalid or lossy JSON cannot silently enter the bank', t => {
  const bank = fixture(t).open()
  for (const value of [NaN, undefined, BigInt(1), new Date(), [, 1]]) {
    assert.throws(() => bank.register({ ...strategy(), provenance: { value } }))
  }
  assert.throws(() => bank.register({ ...strategy(), schemaVersion: 2 }))
  assert.throws(() => bank.register({ ...strategy(), extra: true }))
  assert.equal(bank.listStrategies().length, 0)
})

test('migration refuses a database created by a newer schema', t => {
  const { dir, open } = fixture(t)
  open().close()
  const db = new DatabaseSync(join(dir, 'bank.sqlite'))
  db.exec('PRAGMA user_version = 999'); db.close()
  assert.throws(() => open(), /newer/i)
})

test('an abruptly terminated owner leaves recoverable history, never implicit success', async t => {
  const { dir, open } = fixture(t)
  const bank = open(); bank.register(strategy())
  const module = new URL('../../src/bank/index.js', import.meta.url).href
  const exit = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { StrategyBank } from ${JSON.stringify(module)};
      const bank = new StrategyBank({dataDir:${JSON.stringify(dir)}});
      bank.beginAttempt(${JSON.stringify(input())});
      bank.appendEvent('attempt-1','checkpoint',{kind:'started',payload:{model:'offline'}});
      process.exit(23);
    `])
    child.on('error', reject); child.on('exit', resolve)
  })
  assert.equal(exit, 23)
  const recovered = open()
  assert.equal(recovered.getAttempt('attempt-1').state, 'running')
  assert.equal(recovered.getEvents('attempt-1').length, 1)
  recovered.recoverInterrupted(['attempt-1'], 'owner exited with code 23')
  assert.equal(recovered.getAttempt('attempt-1').state, 'interrupted')
})

test('cancellation, artifact conflicts and rejected attempts retain earlier data', t => {
  const bank = fixture(t).open(); bank.register(strategy()); bank.beginAttempt(input())
  const ref = bank.putArtifact(Buffer.from('red'))
  bank.attachArtifact('attempt-1', 'report', ref)
  assert.throws(() => bank.attachArtifact('attempt-1', 'report', bank.putArtifact(Buffer.from('green'))), /immutable/)
  assert.throws(() => bank.beginAttempt({ ...input(), request: { ...request(), taskId: 'new-task' } }))
  assert.equal(bank.exportJsonl().includes('new-task'), false, 'failed attempt insert rolls back its task insert')
  bank.cancelAttempt('attempt-1', 'user stopped')
  assert.equal(bank.getAttempt('attempt-1').state, 'cancelled')
  assert.equal(bank.getAttempt('attempt-1').outcome, null)
  assert.throws(() => bank.finalizeAttempt('attempt-1', evaluation('success'), outcome), /terminal/)
})

test('independent processes serialize concurrent writes and deduplicate shared events', async t => {
  const { dir, open } = fixture(t)
  const bank = open(); bank.register(strategy()); bank.beginAttempt(input())
  const module = new URL('../../src/bank/index.js', import.meta.url).href
  const workers = Array.from({ length: 3 }, (_, i) => new Promise((resolve, reject) => {
    const code = `import {StrategyBank} from ${JSON.stringify(module)};
      const b = new StrategyBank({dataDir: ${JSON.stringify(dir)}});
      b.appendEvent('attempt-1', 'shared', {kind:'usage', payload:{tokens:5}});
      for(let j=0;j<15;j++) b.appendEvent('attempt-1', '${i}-'+j, {kind:'usage', payload:{tokens:1}});
      b.close();`
    const child = spawn(process.execPath, ['--input-type=module', '-e', code])
    let stderr = ''; child.stderr.on('data', data => { stderr += data })
    child.on('error', reject)
    child.on('exit', exit => exit === 0 ? resolve() : reject(new Error(stderr)))
  }))
  await Promise.all(workers)
  const events = bank.getEvents('attempt-1')
  assert.equal(events.length, 46)
  assert.deepEqual(events.map(e => e.sequence), Array.from({ length: 46 }, (_, i) => i + 1))
  assert.equal(events.reduce((sum, e) => sum + e.payload.tokens, 0), 50)
})
