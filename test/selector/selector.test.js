import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { StrategyBank } from '../../src/bank/index.js'
import { TDDEvaluator } from '../../src/evaluation/index.js'
import { MetricsCollector } from '../../src/metrics/index.js'
import { canonicalJson } from '../../src/contracts/bank.js'
import * as api from '../../src/selector/index.js'

const at = '2099-01-01T00:00:00.000Z'
const request = (id = 'query', description = 'Fix Python bug') => ({ schemaVersion: 1,
  taskId: id, description, repo: 'fixture', baseCommit: 'abc', testSpec: {}, provenance: {} })
const candidate = (id = 'a', overrides = {}) => ({ schemaVersion: 1,
  strategy: { strategyId: id, version: 1 },
  route: { models: ['offline/model@1'], tools: ['tests'], maxConcurrency: 1, tdd: true },
  taskTypes: [], estimates: { wallTimeMs: 10, costMicrounits: 5, quality: 0.9, currency: 'USD', source: 'fixture' },
  ...overrides })
const policy = (overrides = {}) => ({ schemaVersion: 1, revision: 'fixture-v1', alpha: 0.2, lambda: 1,
  weights: { quality: 1, time: 0, cost: 0 }, normalization: { wallTimeMs: 100, costMicrounits: 100 },
  currency: 'USD', allowedModels: ['offline/model@1'], allowedTools: ['tests'], maxConcurrency: 2,
  maxWallTimeMs: null, maxCostMicrounits: null, minQuality: null, ...overrides })
const digest = value => createHash('sha256').update(canonicalJson(value)).digest('hex')
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'selector-'))
  const bank = new StrategyBank({ dataDir: dir })
  t.after(() => { bank.close(); rmSync(dir, { recursive: true, force: true }) })
  for (const id of ['a', 'b']) bank.register({ schemaVersion: 1, strategyId: id, version: 1, provenance: {},
    workflow: { name: id, description: 'fixture', stages: [{ title: 'code', agents: [{ id: 'coder', prompt: 'code' }] }] } })
  const snapshot = (ids = []) => api.createSelectorSnapshot(bank, { trainingTaskIds: ids, cutoff: at })
  const select = (r = request(), candidates = [candidate()], p = policy(), s = snapshot()) =>
    api.selectStrategy({ request: r, candidates, policy: p, snapshot: s, selectedAt: at })
  const add = (id, c, description, status = 'success', cost = 10, time = 10) => {
    const r = request(id, description)
    const decision = select(r, [c])
    bank.beginAttempt({ attemptId: id, request: r, strategy: c.strategy, selection: { selector: decision } })
    if (status === 'cancelled') { bank.cancelAttempt(id, 'fixture'); return }
    const evaluation = { schemaVersion: 2, status,
      correctness: status === 'success' ? 'passed' : status === 'failed' ? 'failed' : 'inconclusive',
      tddCompliance: status === 'success' ? 'passed' : 'inconclusive',
      requiredTests: [{ id: 'target', status: status === 'success' ? 'passed' : 'failed' }],
      evidence: { specHash: digest(r.testSpec) },
      provenance: { source: 'independent-node-evaluator', revision: 'v1', evaluatorId: id } }
    bank.appendEvent(id, 'evaluation-session', { kind: 'evaluation-session',
      payload: { evaluatorId: id, specHash: digest(r.testSpec) } })
    bank.finalizeAttempt(id, evaluation, { schemaVersion: 1, measured: { wallTimeMs: time, coverageComplete: cost !== null, observedCallCount: 1 },
      calculated: { pricingComplete: cost !== null, costs: [{ currency: 'USD', microunits: cost }] },
      estimates: { wallTimeMs: 0, costMicrounits: 0 }, provenance: { source: 'metrics-collector-v1', attemptId: id } })
  }
  return { bank, snapshot, select, add }
}

test('cold start has real LinUCB uncertainty, stable ties and auditable decision', t => {
  assert.equal(typeof api.selectStrategy, 'function')
  const { select } = fixture(t)
  const d = select(request(), [candidate('b'), candidate('a')])
  assert.equal(d.algorithm, 'disjoint-linucb-v1')
  assert.equal(d.selected.strategy.strategyId, 'a')
  assert.equal(d.propensity, null)
  assert.equal(d.scores[0].mean, 0)
  assert.ok(Math.abs(d.scores[0].bonus - 0.2 * Math.sqrt(3)) < 1e-12)
  assert.deepEqual(d, select(request(), [candidate('a'), candidate('b')]))
})

test('hard filters apply before exploration and unknown constrained forecasts fail closed', t => {
  const { select } = fixture(t)
  const unknown = candidate('b', { estimates: { ...candidate().estimates, costMicrounits: null } })
  const d = select(request(), [candidate('a'), unknown], policy({ maxCostMicrounits: 4 }))
  assert.equal(d.selected, null)
  assert.equal(d.excluded.length, 2)
  assert.ok(d.excluded[1].reasons.includes('cost-unavailable'))
  const bad = candidate('a', { route: { ...candidate().route, models: ['blocked'], tdd: false, maxConcurrency: 3 }, taskTypes: ['feature'] })
  const reasons = select(request(), [bad]).excluded[0].reasons
  for (const reason of ['models', 'concurrency', 'tdd', 'task-type']) assert.ok(reasons.includes(reason))
  assert.equal(select(request(), [candidate()], policy({ minQuality: 0.95 })).selected, null)
})

test('one observation matches the closed-form ridge prediction and exploration bonus', t => {
  const { add, snapshot, select } = fixture(t)
  add('train', candidate(), 'Fix Python bug')
  const d = select(request(), [candidate()], policy(), snapshot(['train']))
  assert.equal(d.scores[0].samples, 1)
  assert.ok(Math.abs(d.scores[0].mean - 3 / 4) < 1e-12)
  assert.ok(Math.abs(d.scores[0].bonus - 0.2 * Math.sqrt(3 / 4)) < 1e-12)
})

test('context changes the selected strategy on independent tasks', t => {
  const { add, snapshot, select } = fixture(t)
  for (let i = 0; i < 4; i++) {
    add(`ap${i}`, candidate('a'), 'Fix Python bug')
    add(`aj${i}`, candidate('a'), 'Fix Java bug', 'failed')
    add(`bp${i}`, candidate('b'), 'Fix Python bug', 'failed')
    add(`bj${i}`, candidate('b'), 'Fix Java bug')
  }
  const ids = ['ap', 'aj', 'bp', 'bj'].flatMap(prefix => [0, 1, 2, 3].map(i => prefix + i))
  const s = snapshot(ids)
  assert.equal(select(request('new-p', 'Fix Python bug'), [candidate('a'), candidate('b')], policy(), s).selected.strategy.strategyId, 'a')
  assert.equal(select(request('new-j', 'Fix Java bug'), [candidate('a'), candidate('b')], policy(), s).selected.strategy.strategyId, 'b')
})

test('preferences use measured values; cheap failed attempts cannot become successes', t => {
  const { add, snapshot, select } = fixture(t)
  add('a-train', candidate('a'), 'Fix Python bug', 'success', 1, 90)
  add('b-train', candidate('b'), 'Fix Python bug', 'success', 90, 1)
  const s = snapshot(['a-train', 'b-train'])
  assert.equal(select(request(), [candidate('a'), candidate('b')], policy({ weights: { quality: 0, time: 0, cost: 1 } }), s).selected.strategy.strategyId, 'a')
  assert.equal(select(request(), [candidate('a'), candidate('b')], policy({ weights: { quality: 0, time: 1, cost: 0 } }), s).selected.strategy.strategyId, 'b')
  add('bad', candidate('a'), 'Fix Python bug', 'failed', 0, 0)
  const bad = select(request(), [candidate()], policy({ weights: { quality: 0, time: 0, cost: 1 } }), snapshot(['bad']))
  assert.equal(bad.training[0].reward, -1)
})

test('missing metrics, unverified quality and incomplete outcomes are logged without invented reward', t => {
  const { add, snapshot, select } = fixture(t)
  add('unknown-cost', candidate(), 'Fix Python bug', 'success', null)
  add('incomplete', candidate(), 'Fix Python bug', 'inconclusive')
  add('cancelled', candidate(), 'Fix Python bug', 'cancelled')
  const d = select(request(), [candidate()], policy({ weights: { quality: 0, time: 0, cost: 1 } }), snapshot(['unknown-cost', 'incomplete', 'cancelled']))
  assert.equal(d.training.find(r => r.attemptId === 'unknown-cost').reward, null)
  assert.equal(d.training.find(r => r.attemptId === 'incomplete').reward, null)
  assert.equal(d.training.find(r => r.attemptId === 'cancelled').reward, -1)
})

test('frozen history excludes held-out, self and later results; route changes do not inherit learning', t => {
  const { add, snapshot, select, bank } = fixture(t)
  add('train', candidate(), 'Fix Python bug')
  add('held-out', candidate(), 'Fix Python bug')
  const s = snapshot(['train'])
  assert.equal(s.records.length, 1)
  assert.equal(select(request('train'), [candidate()], policy(), s).scores[0].samples, 0)
  add('later', candidate(), 'Fix Python bug')
  assert.equal(select(request(), [candidate()], policy(), s).scores[0].samples, 1)
  const different = candidate('a', { route: { ...candidate().route, models: ['offline/model@2'] } })
  assert.equal(select(request(), [different], policy({ allowedModels: ['offline/model@2'] }), s).scores[0].samples, 0)
  const before = api.createSelectorSnapshot(bank, { trainingTaskIds: ['train'], cutoff: bank.getAttempt('train').finishedAt })
  assert.equal(before.records.length, 0)
  s.records[0].state = 'failed'
  assert.throws(() => select(request(), [candidate()], policy(), s), /snapshot/i)
})

test('contracts reject invalid weights, duplicate arms, future snapshots and bad numeric input', t => {
  const { select, snapshot, bank } = fixture(t)
  assert.throws(() => api.createSelectorSnapshot(bank, {}), /trainingTaskIds/)
  assert.throws(() => select(request(), [candidate()], policy({ weights: { quality: 0, time: 0, cost: 0 } })), /weights/)
  assert.throws(() => select(request(), [candidate(), candidate()]), /duplicate/i)
  assert.throws(() => select(request(), [candidate()], policy({ lambda: 0 })), /lambda/)
  assert.throws(() => api.selectStrategy({ request: request(), candidates: [], policy: policy(), snapshot: snapshot(), selectedAt: '2000-01-01T00:00:00.000Z' }), /cutoff/)
})

test('legacy successes without independent evaluator binding are not training rewards', t => {
  const { bank, select, snapshot } = fixture(t)
  const r = request('legacy')
  bank.beginAttempt({ attemptId: 'legacy', request: r, strategy: candidate().strategy,
    selection: { selector: select(r) } })
  bank.finalizeAttempt('legacy', { status: 'success', requiredTests: [{ id: 'target', status: 'passed' }], provenance: {} },
    { measured: { wallTimeMs: 0 }, estimates: {} })
  const d = select(request(), [candidate()], policy(), snapshot(['legacy']))
  assert.equal(d.training[0].reward, null)
  assert.equal(d.training[0].reason, 'unverified-quality')
})

test('real evaluator and metrics feed a replayable decision without model calls', async t => {
  const { bank, select, snapshot } = fixture(t)
  const testSpec = { schemaVersion: 1, id: 'selector-evidence', acceptanceCriteria: ['returns one'],
    timeoutMs: 3000, maxOutputBytes: 100000, suites: [
      { id: 'target', kind: 'target', expectedRedTests: ['one'], files: { 'test/target.test.cjs':
        "const {test}=require('node:test'); const assert=require('node:assert/strict'); test('one',()=>assert.equal(require('../subject.cjs'),1));" } },
      { id: 'regression', kind: 'regression', expectedRedTests: [], files: { 'test/regression.test.cjs':
        "require('node:test').test('numeric',()=>require('node:assert/strict').equal(typeof require('../subject.cjs'),'number'));" } },
    ] }
  const r = { ...request('real', 'Fix JavaScript bug'), testSpec }
  bank.beginAttempt({ attemptId: 'real', request: r, strategy: candidate().strategy, selection: { selector: select(r) } })
  const metrics = new MetricsCollector({ bank, attemptId: 'real' })
  const evaluator = new TDDEvaluator({ bank, attemptId: 'real', spec: testSpec })
  const base = { revision: 'abc', files: { 'subject.cjs': 'module.exports=0' } }
  await evaluator.runPhase('baseline', base)
  await evaluator.runPhase('red', base)
  await evaluator.runPhase('green', { revision: 'green', files: { 'subject.cjs': 'module.exports=1' } })
  await evaluator.runPhase('refactor', { revision: 'final', files: { 'subject.cjs': 'module.exports=1' } })
  metrics.finish('completed', { coverageComplete: true })
  evaluator.finalize(metrics.snapshot())
  const frozen = snapshot(['real'])
  const p = policy({ weights: { quality: 0.5, cost: 0.5, time: 0 } })
  const d = select(request('new', 'Fix JavaScript bug'), [candidate()], p, frozen)
  assert.equal(d.training[0].reward, 1, 'complete zero-call accounting is a real zero')
  const artifact = bank.putArtifact(Buffer.from(JSON.stringify(frozen)))
  assert.deepEqual(select(request('new', 'Fix JavaScript bug'), [candidate()], p, JSON.parse(bank.getArtifact(artifact))), d)
})
