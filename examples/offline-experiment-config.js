import { advanceFeedback } from '../src/feedback/index.js'
import { armId } from '../src/selector/contracts.js'
export function offlineExperimentConfig(bank) {
  const candidates = ['good', 'cheap'].map(model => {
    const strategy = bank.register({ schemaVersion: 1, strategyId: model, version: 1, provenance: { source: 'synthetic-fixture' },
      workflow: { name: model, description: 'offline fixture', stages: [{ title: 'code', agents: [{ id: 'coder', prompt: 'fixture' }] }] } })
    return { schemaVersion: 1, strategy, route: { models: [`offline/${model}`], tools: [], maxConcurrency: 1, tdd: true }, taskTypes: [],
      estimates: { wallTimeMs: 1000, costMicrounits: model === 'good' ? 6 : 1, quality: null, currency: 'USD', source: 'synthetic forecast' } }
  })
  const snapshot = (revision, code) => ({ revision, files: { 'subject.cjs': `exports.solve=(a,b)=>${code};` } })
  const fixtures = {}, tasks = ['addition', 'multiplication'].map(taskId => {
    const expression = taskId === 'addition' ? 'a+b' : 'a*b', expected = taskId === 'addition' ? 5 : 6
    const baseSnapshot = snapshot('base', '0')
    fixtures[taskId] = { green: snapshot('green', expression), refactor: snapshot('refactor', expression), broken: snapshot('broken', '0') }
    const request = { schemaVersion: 1, taskId, description: `Fix JavaScript ${taskId}`, repo: 'offline-fixtures', baseCommit: 'base', provenance: { source: 'synthetic' },
      testSpec: { schemaVersion: 1, id: taskId, acceptanceCriteria: [`Correct ${taskId}`], timeoutMs: 2000, maxOutputBytes: 100000, suites: [
        { id: 'target', kind: 'target', expectedRedTests: ['solves'], files: { 'target.test.cjs': `const {test}=require('node:test'); const assert=require('node:assert/strict'); test('solves',()=>assert.equal(require('./subject.cjs').solve(2,3),${expected}));` } },
        { id: 'regression', kind: 'regression', expectedRedTests: [], files: { 'regression.test.cjs': `const {test}=require('node:test'); const assert=require('node:assert/strict'); test('export',()=>assert.equal(typeof require('./subject.cjs').solve,'function'));` } }] } }
    const bindings = candidates.map(c => ({ schemaVersion: 1, armId: armId(c), greenTaskId: 'green', refactorTaskId: 'refactor',
      plan: { version: 3, execution: 'dag', name: taskId, description: 'Synthetic offline comparison',
        resources: { agentSlots: 1, timeoutMs: 5000, maxArtifactBytes: 10000, maxInputBytes: 20000 },
        tasks: ['green', 'refactor'].map(phase => ({ id: phase, prompt: JSON.stringify({ phase }), slots: 1,
          model: { provider: 'offline', model: c.strategy.strategyId }, dependsOn: phase === 'green' ? [] : ['green'],
          inputs: phase === 'green' ? [] : [{ name: 'source', taskId: 'green' }] })) } }))
    return { request, baseSnapshot, bindings, durations: Object.fromEntries(bindings.map(b => [b.armId, { green: 1, refactor: 1 }])) }
  })
  const policy = { schemaVersion: 1, revision: 'offline-v1', alpha: 0.2, lambda: 1, weights: { quality: 1, time: 0, cost: 0 }, normalization: { wallTimeMs: 1000, costMicrounits: 100 },
    currency: 'USD', allowedModels: ['offline/good', 'offline/cheap'], allowedTools: [], maxConcurrency: 1, maxWallTimeMs: 10000, maxCostMicrounits: 100, minQuality: null }
  const feedback = advanceFeedback(bank, { manifest: { schemaVersion: 1, experimentId: 'offline-demo', mode: 'frozen', splits: { train: [], validation: [], test: tasks.map(t => t.request.taskId) } },
    policy, cutoff: '2000-01-01T00:00:00.000Z' })
  const prices = Object.fromEntries(['good', 'cheap'].map(model => [model, { schemaVersion: 1, id: `fixture-${model}`, provider: 'offline', model, modelRevision: 'fixture-v1',
    currency: 'USD', effectiveAt: '2026-01-01T00:00:00.000Z', source: 'Synthetic test tariff; no API billing',
    rates: { inputTokens: model === 'good' ? 1000000 : 0, outputTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0 } }]))
  return { experimentId: 'offline-demo-v1', feedback, candidates, tasks, seeds: [7, 11], fixedArmId: armId(candidates[0]),
    runtimeConfig: { source: 'synthetic-offline-fixtures-v1', fixtures, prices } }
}
