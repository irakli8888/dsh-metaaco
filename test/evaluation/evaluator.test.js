import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TDDEvaluator } from '../../src/evaluation/index.js'
import { StrategyBank } from '../../src/bank/index.js'

const spec = () => ({ schemaVersion: 1, id: 'addition-v1', acceptanceCriteria: ['Add two numbers without breaking identity'],
  timeoutMs: 3000, maxOutputBytes: 100000,
  suites: [
    { id: 'target', kind: 'target', expectedRedTests: ['adds'], files: { 'test/target.test.cjs': `
      const {test} = require('node:test'); const assert = require('node:assert/strict');
      const {add} = require('../subject.cjs');
      test('adds', () => assert.equal(add(1,2),3));` } },
    { id: 'regression', kind: 'regression', expectedRedTests: [], files: { 'test/regression.test.cjs': `
      const {test} = require('node:test'); const assert = require('node:assert/strict');
      const {identity} = require('../subject.cjs');
      test('preserves identity', () => assert.equal(identity(4),4));` } },
  ] })
const snapshot = (revision, add = '0', identity = 'x') => ({ revision,
  files: { 'subject.cjs': `exports.add = (a,b) => ${add}; exports.identity = x => ${identity};` } })
const base = () => snapshot('base')
const green = () => snapshot('implementation', 'a+b')
const refactor = () => snapshot('final', 'b+a')

async function runAll(evaluator, { initial = base(), implementation = green(), final = refactor() } = {}) {
  await evaluator.runPhase('baseline', initial)
  await evaluator.runPhase('red', initial)
  await evaluator.runPhase('green', implementation)
  await evaluator.runPhase('refactor', final)
  return evaluator.evaluate()
}

test('actual RED assertion, GREEN and REFACTOR produce independent success with reproducible provenance', async () => {
  const evaluator = new TDDEvaluator({ spec: spec() })
  const result = await runAll(evaluator)
  assert.equal(result.status, 'success')
  assert.equal(result.correctness, 'passed'); assert.equal(result.tddCompliance, 'passed')
  assert.deepEqual(result.requiredTests.map(t => t.status), ['passed', 'passed'])
  const red = result.evidence.phases[1].reports[0]
  assert.equal(red.exitCode, 1); assert.equal(red.tests[0].code, 'ERR_ASSERTION')
  assert.equal(red.status, 'failed'); assert.equal(red.counts.failed, 1)
  assert.ok(red.stdout.includes('adds')); assert.equal(red.stderr, '')
  assert.equal(red.testSuiteHash.length, 64); assert.ok(red.durationMs > 0)
  assert.equal(red.command[0], process.execPath)
  result.evidence.phases[0].phase = 'forged'
  assert.equal(evaluator.evaluate().evidence.phases[0].phase, 'baseline')
})

test('passing code without RED is correct but has inconclusive TDD', async () => {
  const evaluator = new TDDEvaluator({ spec: spec() })
  await evaluator.runPhase('green', green()); await evaluator.runPhase('refactor', refactor())
  const result = evaluator.evaluate()
  assert.equal(result.correctness, 'passed'); assert.equal(result.tddCompliance, 'inconclusive')
  assert.equal(result.status, 'inconclusive')
})

test('a mandatory regression failure or broken refactor cannot be reported as success', async () => {
  for (const final of [snapshot('broken-refactor', '0'), snapshot('broken-regression', 'a+b', '0')]) {
    const result = await runAll(new TDDEvaluator({ spec: spec() }), { final })
    assert.equal(result.status, 'failed'); assert.equal(result.correctness, 'failed')
    assert.ok(result.requiredTests.some(t => t.status === 'failed'))
  }
})

test('an import error is an environment error, never evidence of RED', async () => {
  const initial = { revision: 'missing-module', files: {} }
  const result = await runAll(new TDDEvaluator({ spec: spec() }), { initial })
  assert.equal(result.evidence.phases[1].reports[0].status, 'error')
  assert.notEqual(result.tddCompliance, 'passed'); assert.notEqual(result.status, 'success')
  assert.equal(result.correctness, 'passed')
})

test('a RED suite that already passed does not establish the requested defect', async () => {
  const result = await runAll(new TDDEvaluator({ spec: spec() }), { initial: green() })
  assert.equal(result.correctness, 'passed'); assert.equal(result.tddCompliance, 'failed')
  assert.notEqual(result.status, 'success')
})

test('skipped target tests and timeouts do not establish GREEN or RED', async () => {
  const skipped = spec()
  skipped.suites[0].files['test/target.test.cjs'] = `require('node:test').test.skip('adds',()=>{});`
  const result = await runAll(new TDDEvaluator({ spec: skipped }))
  assert.equal(result.correctness, 'inconclusive'); assert.equal(result.status, 'inconclusive')
  const hanging = spec(); hanging.timeoutMs = 500
  hanging.suites[0].files['test/target.test.cjs'] = `require('node:test').test('adds',async()=>new Promise(()=>{})); setInterval(()=>{},1000);`
  const evaluator = new TDDEvaluator({ spec: hanging })
  const red = await evaluator.runPhase('red', base())
  assert.equal(red.reports[0].status, 'timeout'); assert.ok(red.reports[0].durationMs < 2500)
  assert.equal(evaluator.evaluate().status, 'inconclusive')
})

test('pinned tests, source snapshots and phase chronology cannot be rewritten', async () => {
  const original = spec(); const evaluator = new TDDEvaluator({ spec: original })
  original.suites[0].files['test/target.test.cjs'] = 'process.exit(0)'
  const initial = base()
  const pending = evaluator.runPhase('baseline', initial)
  initial.files['subject.cjs'] = 'throw Error("mutated")'
  await assert.rejects(evaluator.runPhase('green', green()), /already running/)
  assert.equal((await pending).reports[0].status, 'passed')
  await assert.rejects(evaluator.runPhase('red', green()), /baseline snapshot/)
  await evaluator.runPhase('red', base())
  await evaluator.runPhase('green', green())
  await assert.rejects(evaluator.runPhase('red', base()), /order/)
  await assert.rejects(evaluator.runPhase('refactor', { revision: 'tamper', files: { 'test/target.test.cjs': '' } }), /pinned/)
  await assert.rejects(evaluator.runPhase('refactor', { revision: 'escape', files: { '../escape.cjs': '' } }), /Unsafe/)
  await evaluator.runPhase('refactor', refactor())
  assert.equal(evaluator.evaluate().status, 'success')
})

test('unexpected RED assertions cannot be substituted for the pinned failing test names', async () => {
  const pinned = spec(); pinned.suites[0].expectedRedTests = ['different test']
  const result = await runAll(new TDDEvaluator({ spec: pinned }))
  assert.equal(result.correctness, 'inconclusive'); assert.equal(result.tddCompliance, 'failed')
})

test('aborted runs and excessive output are captured as incomplete evidence', async () => {
  const controller = new AbortController(); controller.abort()
  const evaluator = new TDDEvaluator({ spec: spec() })
  const phase = await evaluator.runPhase('red', base(), { signal: controller.signal })
  assert.equal(phase.reports[0].status, 'cancelled')
  assert.equal(evaluator.evaluate().status, 'inconclusive')
  const noisy = spec(); noisy.maxOutputBytes = 100
  const report = await new TDDEvaluator({ spec: noisy }).runPhase('green', green())
  assert.ok(report.reports.every(r => r.status === 'output-limit'))
})

test('evaluator pins the bank request, persists its own evidence and finalizes independently', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'evaluator-bank-'))
  const bank = new StrategyBank({ dataDir: dir })
  t.after(() => { bank.close(); rmSync(dir, { recursive: true, force: true }) })
  const pinned = spec()
  const strategy = bank.register({ schemaVersion: 1, strategyId: 'fixed', version: 1,
    provenance: { source: 'test' }, workflow: { name: 'fixed', description: 'test', stages: [
      { title: 'Implement', agents: [{ id: 'coder', prompt: 'implement' }] },
    ] } })
  bank.beginAttempt({ attemptId: 'attempt', strategy, selection: {}, request: {
    schemaVersion: 1, taskId: 'task', description: 'add', repo: 'fixture', baseCommit: 'base',
    testSpec: pinned, provenance: { source: 'test' },
  } })
  assert.throws(() => new TDDEvaluator({ spec: { ...pinned, id: 'replacement' }, bank, attemptId: 'attempt' }), /pinned/)
  const evaluator = new TDDEvaluator({ spec: pinned, bank, attemptId: 'attempt' })
  const result = await runAll(evaluator)
  evaluator.finalize({ measured: { cost: null }, estimates: {} })
  assert.equal(bank.getAttempt('attempt').state, 'succeeded')
  assert.deepEqual(bank.getAttempt('attempt').evaluation, result)
  assert.equal(bank.getEvents('attempt').filter(e => e.kind === 'evaluation-phase').length, 4)
  const exportRecords = bank.exportJsonl().trim().split('\n').map(JSON.parse)
  const binding = exportRecords.find(r => r.type === 'attemptArtifact' && r.value.name === 'evaluation-result')
  const ref = exportRecords.find(r => r.type === 'artifact' && r.value.sha256 === binding.value.sha256).value
  assert.deepEqual(JSON.parse(bank.getArtifact(ref)), result)
  await assert.rejects(evaluator.runPhase('green', green()), /finalized/)
})

test('candidate code cannot rewrite pinned tests while running and still obtain GREEN', async () => {
  const mutating = { revision: 'mutating-tests', files: { 'subject.cjs': `
    require('node:fs').writeFileSync('test/target.test.cjs', '// erased');
    exports.add=(a,b)=>a+b; exports.identity=x=>x;` } }
  const evaluator = new TDDEvaluator({ spec: spec() })
  const phase = await evaluator.runPhase('green', mutating)
  assert.equal(phase.reports[0].status, 'integrity-error')
  assert.equal(evaluator.evaluate().correctness, 'inconclusive')
})

test('a running test can be cancelled and a zero-test exit cannot imply correctness', async () => {
  const hanging = spec()
  hanging.suites[0].files['test/target.test.cjs'] = `setInterval(()=>{},1000);`
  const evaluator = new TDDEvaluator({ spec: hanging })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 150)
  try {
    const phase = await evaluator.runPhase('red', base(), { signal: controller.signal })
    assert.equal(phase.reports[0].status, 'cancelled')
  } finally { clearTimeout(timer) }
  const empty = spec(); empty.suites[0].files['test/target.test.cjs'] = 'process.exit(0)'
  const result = await runAll(new TDDEvaluator({ spec: empty }))
  assert.notEqual(result.correctness, 'passed'); assert.notEqual(result.status, 'success')
})

test('an unexpected runner setup failure cannot reuse a previous successful final snapshot', async () => {
  const evaluator = new TDDEvaluator({ spec: spec() })
  assert.equal((await runAll(evaluator)).status, 'success')
  await assert.rejects(evaluator.runPhase('refactor', { revision: 'invalid-test-directory', files: { test: 'blocking directory' } }))
  const result = evaluator.evaluate()
  assert.equal(result.status, 'inconclusive')
  assert.equal(result.correctness, 'inconclusive')
  assert.ok(result.evidence.phases.at(-1).error)
})
