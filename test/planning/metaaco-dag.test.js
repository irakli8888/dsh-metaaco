import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { canonicalJson } from '../../src/contracts/bank.js'
import * as api from '../../src/planning/index.js'

const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex')
const problem = () => ({ version: 2, plan: { version: 3, execution: 'dag', name: 'fixture', description: 'offline',
  resources: { agentSlots: 2, maxArtifactBytes: 1024, maxInputBytes: 4096, timeoutMs: 5000 },
  tasks: [
    { id: 'a', prompt: 'a', dependsOn: [], inputs: [], slots: 1, model: null },
    { id: 'b', prompt: 'b', dependsOn: [], inputs: [], slots: 1, model: null },
    { id: 'c', prompt: 'c', dependsOn: ['a'], inputs: [{ name: 'source', taskId: 'a' }], slots: 1, model: null },
  ] }, durationEstimatesSeconds: { a: 10, b: 30, c: 10 } })
function envelope(p = problem()) {
  return { schemaVersion: 1, planner: 'python-metaaco-dag', plan: structuredClone(p.plan),
    estimates: { durationUnit: 'seconds', scheduleMakespan: 30, executionMakespan: null, reason: 'contract fixture',
      order: ['a', 'b', 'c'], schedule: [
        { taskId: 'a', startSeconds: 0, durationSeconds: 10 },
        { taskId: 'b', startSeconds: 0, durationSeconds: 30 },
        { taskId: 'c', startSeconds: 10, durationSeconds: 10 },
      ] }, measured: { solverWallTimeMs: 1, evaluations: 100 },
    provenance: { seed: 42, parameters: { max_colonies: 10, max_evaluations: 100,
      replication_enabled: true, elite_enabled: true, local_search_enabled: true, selection: 'ucb', replication_mode: 'mutate',
      init_colonies: 3, iterations: 20, ants_per_iteration: 5, improvement_threshold: 0.02 },
    sourceFiles: { 'rcpsp/core.py': 'a'.repeat(64), 'rcpsp/metaACO.py': 'b'.repeat(64) },
    bridgeSha256: 'c'.repeat(64), pythonVersion: 'fixture', problemSha256: hash(p) } }
}

test('validates and snapshots a schedule without inventing execution time', () => {
  assert.equal(typeof api.validateMetaacoDag, 'function')
  const p = problem(), result = envelope(p), validated = api.validateMetaacoDag(result, p)
  assert.deepEqual(validated, result)
  result.plan.tasks[0].prompt = 'changed'
  assert.equal(validated.plan.tasks[0].prompt, 'a')
  assert.equal(validated.estimates.executionMakespan, null)
})

test('independent JS checks reject precedence, capacity, duration and priority corruption', () => {
  const changes = [
    r => { r.estimates.schedule[2].startSeconds = 9 },
    r => { r.estimates.schedule[2].durationSeconds = 11 },
    r => { r.estimates.scheduleMakespan = 31 },
    r => { r.estimates.order = ['c', 'a', 'b'] },
    r => { r.estimates.order = ['a', 'a', 'c'] },
    r => { r.plan.tasks.reverse() },
    r => { r.plan.tasks[2].inputs = [] },
    r => { r.plan.tasks[0].model = { provider: 'other', model: 'other' } },
    r => { r.provenance.problemSha256 = '0'.repeat(64) },
    r => { r.provenance.parameters.elite_enabled = false },
    r => { r.measured.evaluations = 101 },
  ]
  for (const change of changes) {
    const p = problem(), r = envelope(p); change(r)
    assert.throws(() => api.validateMetaacoDag(r, p))
  }
  const p = problem(); p.plan.tasks[0].slots = 2
  const r = envelope(p)
  assert.throws(() => api.validateMetaacoDag(r, p), /capacity/)
})

test('duration estimates require exact task coverage and safe positive integers', () => {
  for (const durations of [{ a: 1 }, { a: 1, b: 1, c: 1, extra: 1 }, { a: 0, b: 1, c: 1 },
    { a: Number.MAX_SAFE_INTEGER, b: 1, c: 1 }]) {
    const p = problem(); p.durationEstimatesSeconds = durations
    assert.throws(() => api.validateMetaacoDag(envelope(p), p), /duration/i)
  }
})

test('execution requires consent and validates before touching the bank or Harness', async () => {
  let touched = false
  const bank = { getAttempt() { touched = true; throw new Error('must not execute') } }
  await assert.rejects(api.runMetaacoDag({}, {}, envelope(), problem(), { bank, attemptId: 'test' }), /allowLlm/)
  const bad = envelope(); bad.plan.tasks[0].prompt = 'modified'
  await assert.rejects(api.runMetaacoDag({}, {}, bad, problem(), { bank, attemptId: 'test', allowLlm: true }))
  assert.equal(touched, false)
})
