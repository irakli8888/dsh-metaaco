// Offline example: no Harness provider or model is started.
import { StrategyBank } from 'dsh-metaaco/bank'
import { TDDEvaluator } from 'dsh-metaaco/evaluation'
import { randomUUID } from 'node:crypto'

const dataDir = process.argv[2]
if (!dataDir) throw new Error('Usage: node examples/tdd-evaluation.js /absolute/path/to/history')
const spec = {
  schemaVersion: 1, id: 'sum-v1', acceptanceCriteria: ['Return a+b while preserving identity'],
  timeoutMs: 3000, maxOutputBytes: 100000,
  suites: [
    { id: 'addition', kind: 'target', expectedRedTests: ['adds'], files: { 'test/add.test.cjs': `
      const {test}=require('node:test'); const assert=require('node:assert/strict');
      const {add}=require('../sum.cjs'); test('adds',()=>assert.equal(add(2,3),5));` } },
    { id: 'regression', kind: 'regression', expectedRedTests: [], files: { 'test/identity.test.cjs': `
      const {test}=require('node:test'); const assert=require('node:assert/strict');
      const {identity}=require('../sum.cjs'); test('identity',()=>assert.equal(identity(4),4));` } },
  ],
}
const base = { revision: 'example-base-v1', files: { 'sum.cjs': 'exports.add=()=>0; exports.identity=x=>x;' } }
const bank = new StrategyBank({ dataDir })
try {
  const strategy = bank.register({ schemaVersion: 1, strategyId: 'offline-tdd', version: 1,
    workflow: { name: 'offline-tdd', description: 'Offline example only', stages: [
      { title: 'Implement', agents: [{ id: 'coder', prompt: 'Implement addition' }] },
    ] }, provenance: { source: 'offline-example-v1' } })
  const attemptId = bank.beginAttempt({ attemptId: randomUUID(), strategy, selection: { policy: 'fixed-example-v1' },
    request: { schemaVersion: 1, taskId: 'addition-example-v1', description: 'Add numbers', repo: 'text-fixture',
      baseCommit: base.revision, testSpec: spec, provenance: { source: 'offline-example-v1' } } })
  const evaluator = new TDDEvaluator({ spec, bank, attemptId })
  await evaluator.runPhase('baseline', base)
  await evaluator.runPhase('red', base)
  // In a real flow, only now ask the coding agent to produce the implementation.
  await evaluator.runPhase('green', { revision: 'example-implementation-v1', files: {
    'sum.cjs': 'exports.add=(a,b)=>a+b; exports.identity=x=>x;',
  } })
  await evaluator.runPhase('refactor', { revision: 'example-final-v1', files: {
    'sum.cjs': 'exports.add=(a,b)=>b+a; exports.identity=x=>x;',
  } })
  const result = evaluator.finalize({ measured: { cost: null }, estimates: {},
    unavailable: ['API billing is not collected by this example'] })
  console.log(JSON.stringify({ attemptId, status: result.status, correctness: result.correctness,
    tddCompliance: result.tddCompliance }, null, 2))
} finally { bank.close() }
