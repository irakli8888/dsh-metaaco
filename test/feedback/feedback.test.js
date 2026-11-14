import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StrategyBank } from '../../src/bank/index.js'
import { createSelectorSnapshot, selectStrategy } from '../../src/selector/index.js'
import * as api from '../../src/feedback/index.js'

const cutoff = '2099-01-01T00:00:00.000Z'
const policy = () => ({ schemaVersion: 1, revision: 'v1', alpha: 0.2, lambda: 1,
  weights: { quality: 1, time: 0, cost: 0 }, normalization: { wallTimeMs: 100, costMicrounits: 100 },
  currency: 'USD', allowedModels: ['offline'], allowedTools: [], maxConcurrency: 1,
  maxWallTimeMs: null, maxCostMicrounits: null, minQuality: null })
const manifest = (mode = 'online-train') => ({ schemaVersion: 1, experimentId: 'fixture', mode,
  splits: { train: ['train'], validation: ['validation'], test: ['held-out'] } })
const request = taskId => ({ schemaVersion: 1, taskId, description: 'Fix Python bug', repo: 'fixture',
  baseCommit: 'base', testSpec: {}, provenance: {} })
const candidate = id => ({ schemaVersion: 1, strategy: { strategyId: id, version: 1 },
  route: { models: ['offline'], tools: [], maxConcurrency: 1, tdd: true }, taskTypes: [],
  estimates: { wallTimeMs: null, costMicrounits: null, quality: null, currency: 'USD', source: 'unknown' } })
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'feedback-'))
  const bank = new StrategyBank({ dataDir: dir })
  t.after(() => { bank.close(); rmSync(dir, { recursive: true, force: true }) })
  for (const id of ['a', 'b']) bank.register({ schemaVersion: 1, strategyId: id, version: 1, provenance: {},
    workflow: { name: id, description: 'fixture', stages: [{ title: 'work', agents: [{ id: 'coder', prompt: 'code' }] }] } })
  const add = (attemptId, taskId, state = 'cancelled') => {
    const r = request(taskId), selector = selectStrategy({ request: r, candidates: [candidate('a')], policy: policy(),
      snapshot: createSelectorSnapshot(bank, { trainingTaskIds: [], cutoff }), selectedAt: cutoff })
    bank.beginAttempt({ attemptId, request: r, strategy: candidate('a').strategy, selection: { selector } })
    if (state === 'cancelled') bank.cancelAttempt(attemptId, 'fixture')
    if (state === 'failed') bank.finalizeAttempt(attemptId, { status: 'failed', requiredTests: [], provenance: {} },
      { measured: { wallTimeMs: null }, estimates: {} })
    if (state === 'inconclusive') bank.finalizeAttempt(attemptId, { status: 'inconclusive', requiredTests: [], provenance: {} },
      { measured: { wallTimeMs: null }, estimates: {} })
  }
  return { bank, add, dir }
}

test('feedback revisions are immutable, idempotent and retain incomplete training outcomes', t => {
  assert.equal(typeof api.advanceFeedback, 'function')
  const { bank, add } = fixture(t)
  const input = { manifest: manifest(), policy: policy(), cutoff: '2000-01-01T00:00:00.000Z' }
  const root = api.advanceFeedback(bank, input)
  assert.deepEqual(api.advanceFeedback(bank, { ...input, previous: root }), root)
  add('train-failure', 'train', 'failed'); add('train-incomplete', 'train', 'inconclusive')
  const next = api.advanceFeedback(bank, { ...input, cutoff: '2099-01-02T00:00:00.000Z', previous: root })
  const read = api.readFeedback(bank, next)
  assert.deepEqual(read.revision.parent, root)
  assert.equal(read.revision.summary.total, 2)
  assert.equal(read.revision.summary.states.inconclusive, 1)
  assert.deepEqual(read.revision.summary.newAttemptIds, ['train-failure', 'train-incomplete'])
  assert.equal(api.readFeedback(bank, root).snapshot.records.length, 0)
  assert.notEqual(next.sha256, root.sha256)
})

test('advancing training changes selection while frozen revision stays reproducible', t => {
  const { bank, add } = fixture(t)
  const root = api.advanceFeedback(bank, { manifest: manifest(), policy: policy(), cutoff: '2000-01-01T00:00:00.000Z' })
  const choose = revision => api.selectWithFeedback(bank, revision, { request: request('new'),
    candidates: [candidate('a'), candidate('b')], selectedAt: '2099-01-03T00:00:00.000Z' })
  assert.equal(choose(root).selected.strategy.strategyId, 'a')
  add('failure', 'train', 'failed')
  const next = api.advanceFeedback(bank, { manifest: manifest(), policy: policy(), cutoff: '2099-01-02T00:00:00.000Z', previous: root })
  assert.equal(choose(next).selected.strategy.strategyId, 'b')
  assert.equal(choose(root).selected.strategy.strategyId, 'a')
  assert.equal(choose(next).training[0].reward, -1)
})

test('held-out, validation and running attempts cannot enter feedback training', t => {
  const { bank, add } = fixture(t)
  add('test-result', 'held-out'); add('validation-result', 'validation'); add('still-running', 'train', 'running')
  const revision = api.advanceFeedback(bank, { manifest: manifest(), policy: policy(), cutoff })
  assert.equal(api.readFeedback(bank, revision).snapshot.records.length, 0)
  const overlap = manifest(); overlap.splits.test.push('train')
  assert.throws(() => api.advanceFeedback(bank, { manifest: overlap, policy: policy(), cutoff }), /split|disjoint/i)
})

test('lineage rejects policy/split changes, backwards cutoffs and updates in frozen mode', t => {
  const { bank } = fixture(t)
  const frozen = manifest('frozen')
  const root = api.advanceFeedback(bank, { manifest: frozen, policy: policy(), cutoff })
  assert.throws(() => api.advanceFeedback(bank, { manifest: frozen, policy: policy(), cutoff: '2099-01-02T00:00:00.000Z', previous: root }), /frozen/)
  const input = { manifest: manifest(), policy: policy(), cutoff }
  const online = api.advanceFeedback(bank, input)
  assert.throws(() => api.advanceFeedback(bank, { ...input, policy: { ...policy(), alpha: 1 }, previous: online }), /policy|lineage/i)
  assert.throws(() => api.advanceFeedback(bank, { ...input, cutoff: '2000-01-01T00:00:00.000Z', previous: online }), /cutoff/i)
  const changed = manifest(); changed.splits.train.push('other')
  assert.throws(() => api.advanceFeedback(bank, { ...input, manifest: changed, previous: online }), /manifest|lineage/i)
})

test('feedback artifacts can be exported and later used with a reopened bank', t => {
  const { bank, add, dir } = fixture(t)
  add('attempt', 'train')
  const ref = api.advanceFeedback(bank, { manifest: manifest(), policy: policy(), cutoff })
  const before = api.readFeedback(bank, ref)
  assert.ok(bank.exportJsonl().includes(ref.sha256))
  bank.close()
  const reopened = new StrategyBank({ dataDir: dir })
  try { assert.deepEqual(api.readFeedback(reopened, JSON.parse(JSON.stringify(ref))), before) }
  finally { reopened.close() }
})
