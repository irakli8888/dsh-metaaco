import { mkdirSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fixture } from '../fixtures/adaptive.js'
import { advanceFeedback } from '../../src/feedback/index.js'
import { armId } from '../../src/selector/contracts.js'
import { prepareExperiment, runExperiment } from '../../src/experiments/index.js'
export function setup(t) {
  const f = fixture(t)
  const source = join(f.dir, 'source'); mkdirSync(join(source, 'rcpsp'), { recursive: true })
  for (const name of ['core.py', 'metaACO.py']) writeFileSync(join(source, 'rcpsp', name), '# Fingerprint-only fixture; never executed\n')
  const feedback = advanceFeedback(f.bank, { manifest: { ...f.manifest, mode: 'frozen' }, policy: f.policy, cutoff: '2000-01-01T00:00:00.000Z' })
  return { ...f, config: { experimentId: 'comparison', feedback, seeds: [7, 11], fixedArmId: armId(f.candidate), candidates: [f.candidate],
    tasks: [{ request: { ...f.request, taskId: 'heldout' }, baseSnapshot: f.base, bindings: [f.binding], durations: { [f.binding.armId]: { green: 1, refactor: 1 } } }],
    runtimeConfig: { provider: 'offline', revision: 'fixture', tariffs: 'test-only' }, solverSource: source } }
}
test('manifest seals seven paired modes and seeds, and rejects held-out contamination', async t => {
  const f = setup(t)
  const a = await prepareExperiment(f.bank, f.config), b = await prepareExperiment(f.bank, { ...f.config, seeds: [11, 7] })
  assert.deepEqual(a, b)
  const manifest = JSON.parse(f.bank.getArtifact(a))
  assert.equal(manifest.cells.length, 14)
  for (const seed of [7, 11]) assert.equal(new Set(manifest.cells.filter(c => c.seed === seed).map(c => c.mode)).size, 7)
  const contaminated = structuredClone(f.config); contaminated.tasks[0].request.taskId = 'train'
  await assert.rejects(prepareExperiment(f.bank, contaminated), /held-out|test split/)
  await assert.rejects(prepareExperiment(f.bank, { ...f.config, seeds: [7] }), /seeds/)
})
test('consent prevents journals and runtime calls; recorded run cannot replay', async t => {
  const f = setup(t), ref = await prepareExperiment(f.bank, f.config), journal = join(f.dir, 'run.jsonl')
  await assert.rejects(runExperiment(f.bank, ref, { journal, solverSource: f.config.solverSource, runtimeConfig: f.config.runtimeConfig,
    createRuntime: () => { throw new Error('must not run') } }), /allowLlm/)
})
test('summary does not turn missing costs or failed trials into successful cheap runs', async () => {
  const { summarizeExperiment } = await import('../../src/experiments/index.js')
  const rows = [
    { mode: 'fixed', state: 'succeeded', verifiedSuccess: true, totalWallTimeMs: 10, costMicrounits: 3, knownCostMicrounits: 3 },
    { mode: 'fixed', state: 'timeout', verifiedSuccess: false, totalWallTimeMs: 50, costMicrounits: null, knownCostMicrounits: 2 },
  ]
  const s = summarizeExperiment(rows).find(r => r.mode === 'fixed')
  assert.equal(s.successRate, 0.5); assert.equal(s.totalCostMicrounits, null)
  assert.equal(s.costPerSuccessMicrounits, null); assert.equal(s.knownCostMicrounits, 5)
  assert.equal(s.p95WallTimeMs, 50); assert.equal(s.unknownCostCount, 1)
})
test('changed runtime configuration is rejected before journal creation', async t => {
  const f = setup(t), ref = await prepareExperiment(f.bank, f.config)
  await assert.rejects(runExperiment(f.bank, ref, { journal: join(f.dir, 'changed.jsonl'), solverSource: f.config.solverSource,
    runtimeConfig: {}, createRuntime() {}, allowLlm: true }), /Runtime configuration/)
})
