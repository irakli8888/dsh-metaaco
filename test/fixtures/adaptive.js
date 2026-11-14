import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StrategyBank } from '../../src/bank/index.js'
import { advanceFeedback } from '../../src/feedback/index.js'
import { armId } from '../../src/selector/contracts.js'
export const snapshot = (revision, value = 'a+b') => ({ revision, files: { 'subject.cjs': `exports.add=(a,b)=>${value};` } })
export const spec = () => ({ schemaVersion: 1, id: 'add', acceptanceCriteria: ['addition'], timeoutMs: 2000, maxOutputBytes: 100000,
  suites: [{ id: 'target', kind: 'target', expectedRedTests: ['adds'], files: { 'target.test.cjs': `const {test}=require('node:test'); const a=require('node:assert/strict'); test('adds',()=>a.equal(require('./subject.cjs').add(1,2),3));` } },
    { id: 'regression', kind: 'regression', expectedRedTests: [], files: { 'regression.test.cjs': `const {test}=require('node:test'); const a=require('node:assert/strict'); test('export',()=>a.equal(typeof require('./subject.cjs').add,'function'));` } }] })
export const price = { schemaVersion: 1, id: 'fixture', provider: 'offline', model: 'm', modelRevision: '1', currency: 'USD', effectiveAt: '2026-01-01T00:00:00.000Z', source: 'test-only', rates: { inputTokens: 1000000, outputTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0 } }
export function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'adaptive-')), bank = new StrategyBank({ dataDir: dir })
  t.after(() => { bank.close(); rmSync(dir, { recursive: true, force: true }) })
  const strategy = bank.register({ schemaVersion: 1, strategyId: 'tdd', version: 1, provenance: {}, workflow: { name: 'tdd', description: 'fixture', stages: [{ title: 'code', agents: [{ id: 'coder', prompt: 'code' }] }] } })
  const policy = { schemaVersion: 1, revision: 'v1', alpha: 0.2, lambda: 1, weights: { quality: 1, time: 0, cost: 0 }, normalization: { wallTimeMs: 1000, costMicrounits: 100 }, currency: 'USD', allowedModels: ['offline/m'], allowedTools: [], maxConcurrency: 1, maxWallTimeMs: 10000, maxCostMicrounits: 20, minQuality: null }
  const candidate = { schemaVersion: 1, strategy, route: { models: ['offline/m'], tools: [], maxConcurrency: 1, tdd: true }, taskTypes: [], estimates: { wallTimeMs: 100, costMicrounits: 10, quality: null, currency: 'USD', source: 'fixture forecast' } }
  const plan = { version: 3, execution: 'dag', name: 'tdd', description: 'fixture', resources: { agentSlots: 1, maxArtifactBytes: 10000, maxInputBytes: 20000, timeoutMs: 5000 }, tasks: [
    { id: 'green', prompt: 'implement', slots: 1, model: { provider: 'offline', model: 'm' }, dependsOn: [], inputs: [] },
    { id: 'refactor', prompt: 'refactor', slots: 1, model: { provider: 'offline', model: 'm' }, dependsOn: ['green'], inputs: [{ name: 'source', taskId: 'green' }] }] }
  const manifest = { schemaVersion: 1, experimentId: 'fixture', mode: 'online-train', splits: { train: ['train'], validation: [], test: ['heldout'] } }
  const feedback = advanceFeedback(bank, { manifest, policy, cutoff: '2000-01-01T00:00:00.000Z' })
  const request = { schemaVersion: 1, taskId: 'train', description: 'Fix JS addition', repo: 'fixture', baseCommit: 'base', testSpec: spec(), provenance: {} }
  const binding = { schemaVersion: 1, armId: armId(candidate), plan, greenTaskId: 'green', refactorTaskId: 'refactor' }
  return { dir, bank, policy, candidate, plan, manifest, feedback, request, binding, base: snapshot('base', '0') }
}
