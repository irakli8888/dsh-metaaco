import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as api from '../../src/analyzer/index.js'
import { StrategyBank } from '../../src/bank/index.js'

const request = (taskId = 'query', description = 'Fix Python regression') => ({
  schemaVersion: 1, taskId, description, repo: 'fixture', baseCommit: 'abc',
  testSpec: {}, provenance: { source: 'fixture' },
})
const at = '2026-11-14T00:00:00.000Z'
const analyze = (r = request(), hints = {}) => api.analyzeTask(r, { hints, analyzedAt: at })

test('versioned analysis is deterministic, detached and does not retain raw text', () => {
  assert.equal(typeof api.analyzeTask, 'function')
  const r = request()
  const a = analyze(r)
  assert.deepEqual(a, analyze(r))
  assert.equal(a.schemaVersion, 1)
  assert.equal(a.analyzerVersion, 'rules-v1')
  assert.equal(a.classification.type.value, 'bugfix')
  assert.deepEqual(a.stack.value, ['python'])
  assert.equal(a.classification.complexity.value, null)
  assert.ok(a.classification.complexity.reason)
  assert.equal(a.estimates.cost.value, null)
  assert.equal(a.description, undefined)
  r.description = 'other'
  assert.notEqual(a.requestHash, analyze(r).requestHash)
})

test('Russian rules, explicit hints and unknown/ambiguous tasks are explainable', () => {
  assert.equal(analyze(request('ru', 'Исправить ошибку в TypeScript')).classification.type.value, 'bugfix')
  assert.deepEqual(analyze(request('ru', 'Исправить ошибку в TypeScript')).stack.value, ['typescript'])
  const unknown = analyze(request('u', 'Нужно разобраться'))
  assert.equal(unknown.classification.type.value, null)
  assert.equal(unknown.stack.value, null)
  assert.equal(analyze(request('mixed', 'Add feature and fix bug')).classification.type.value, null)
  const explicit = analyze(request(), { type: 'feature', complexity: 'high', stack: ['Python', 'python'],
    requirements: ['preserve-api', 'tdd'] })
  assert.equal(explicit.classification.type.value, 'feature')
  assert.equal(explicit.classification.type.source, 'declared')
  assert.equal(explicit.classification.complexity.value, 'high')
  assert.deepEqual(explicit.requirements, ['preserve-api', 'tdd'])
  assert.deepEqual(explicit.stack.value, ['python'])
})

test('contracts reject outcomes, invalid hints and timestamps', () => {
  assert.throws(() => analyze({ ...request(), outcome: 'success' }), /TaskRequest/)
  assert.throws(() => analyze(request(), { complexity: 'easy' }), /complexity/)
  assert.throws(() => analyze(request(), { measuredCost: 1 }), /hint/)
  assert.throws(() => api.analyzeTask(request(), { analyzedAt: 'yesterday' }), /UTC/)
  assert.throws(() => analyze(request(), { stack: [''] }), /stack/)
})

function history(t) {
  const dir = mkdtempSync(join(tmpdir(), 'analyzer-'))
  const bank = new StrategyBank({ dataDir: dir })
  t.after(() => { bank.close(); rmSync(dir, { recursive: true, force: true }) })
  const strategy = { strategyId: 'fixed', version: 1 }
  bank.register({ schemaVersion: 1, ...strategy, provenance: {}, workflow: {
    name: 'fixture', description: 'offline', stages: [{ title: 'code', agents: [{ id: 'coder', prompt: 'code' }] }],
  } })
  const add = (id, r, state = 'cancelled') => {
    bank.beginAttempt({ attemptId: id, request: r, strategy, selection: {} })
    if (state === 'cancelled') bank.cancelAttempt(id, 'fixture')
    if (state === 'failed') bank.finalizeAttempt(id, { status: 'failed', requiredTests: [], provenance: {} },
      { measured: { cost: 123 }, estimates: {} })
  }
  add('b', request('train-b'), 'failed')
  add('a', request('train-a'))
  add('held-out', request('test'))
  add('running', request('train-running'), 'running')
  return { bank, add }
}
const snapshot = bank => api.createHistorySnapshot(bank, {
  trainingTaskIds: ['train-a', 'train-b', 'train-running'], cutoff: '2099-01-01T00:00:00.000Z',
})

test('history requires explicit train membership and cutoff, includes failures, excludes running', t => {
  const { bank } = history(t)
  assert.throws(() => api.createHistorySnapshot(bank, {}), /trainingTaskIds/)
  const s = snapshot(bank)
  assert.deepEqual(s.entries.map(e => e.request.taskId), ['train-a', 'train-b'])
  assert.equal(s.entries[1].attempts[0].state, 'failed')
  assert.equal(s.entries[1].attempts[0].outcome, undefined)
  assert.deepEqual(api.createHistorySnapshot(bank, { trainingTaskIds: ['train-a'], cutoff: '2000-01-01T00:00:00.000Z' }).entries, [])
})

test('similarity is stable, excludes self and snapshot stays frozen after new attempts', t => {
  const { bank, add } = history(t)
  const s = snapshot(bank)
  const result = api.findSimilarTasks(request(), s)
  assert.deepEqual(result.matches.map(m => m.taskId), ['train-a', 'train-b'])
  assert.ok(result.matches.every(m => m.score === 1))
  assert.equal(result.snapshotId, s.snapshotId)
  assert.deepEqual(api.findSimilarTasks(request('train-a'), s).matches.map(m => m.taskId), ['train-b'])
  add('later', request('train-a'))
  assert.deepEqual(api.findSimilarTasks(request(), s), result)
  assert.notEqual(snapshot(bank).snapshotId, s.snapshotId)
  assert.equal(api.findSimilarTasks(request(), s, { limit: 1 }).matches.length, 1)
})

test('no evidence yields no matches and corrupt snapshots are rejected', t => {
  const { bank } = history(t)
  const s = snapshot(bank)
  assert.deepEqual(api.findSimilarTasks(request('u', 'Нужно разобраться'), s).matches, [])
  assert.throws(() => api.findSimilarTasks(request(), s, { limit: -1 }), /limit/)
  s.entries[0].request.description = 'tampered'
  assert.throws(() => api.findSimilarTasks(request(), s), /snapshot/i)
})

test('analysis and search persist through the existing immutable selection contract', t => {
  const { bank } = history(t)
  const selection = { analysis: analyze(), retrieval: api.findSimilarTasks(request(), snapshot(bank)) }
  bank.beginAttempt({ attemptId: 'new', request: request(), strategy: { strategyId: 'fixed', version: 1 }, selection })
  assert.deepEqual(bank.getAttempt('new').selection, selection)
  assert.ok(bank.exportJsonl().includes('rules-v1'))
})

test('ranking uses feature overlap, never outcomes or the number of attempts', t => {
  const { bank, add } = history(t)
  add('partial', request('partial', 'Fix Java regression'))
  add('repeat', request('train-b'), 'failed')
  const s = api.createHistorySnapshot(bank, { trainingTaskIds: ['partial', 'train-b', 'train-a'],
    cutoff: '2099-01-01T00:00:00.000Z' })
  const matches = api.findSimilarTasks(request(), s).matches
  assert.deepEqual(matches.map(m => m.taskId), ['train-a', 'train-b', 'partial'])
  assert.equal(matches[2].score, 1 / 3)
  assert.deepEqual(matches[2].sharedFeatures, ['type:bugfix'])
  assert.deepEqual(matches[1].attemptIds, ['b', 'repeat'])
  const cutoff = bank.getAttempt('partial').finishedAt
  const before = api.createHistorySnapshot(bank, { trainingTaskIds: ['partial'], cutoff })
  assert.deepEqual(before.entries, [], 'an attempt at the cutoff is not prior history')
})
