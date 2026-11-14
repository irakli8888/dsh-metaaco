import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { fixture } from '../fixtures/adaptive.js'
import { offlineExperimentConfig } from '../../examples/offline-experiment-config.js'
import { createOfflineRuntime } from '../../examples/offline-runtime.js'
import { prepareExperiment, runExperiment } from '../../src/experiments/index.js'

test('seven frozen baselines execute through real MetaACO, Harness and evaluator across paired seeds', {
  timeout: 60000, skip: !process.env.METAACO_SOURCE ? 'Set METAACO_SOURCE for actual solver' : false,
}, async t => {
  const f = fixture(t), config = offlineExperimentConfig(f.bank)
  const ref = await prepareExperiment(f.bank, { ...config, solverSource: process.env.METAACO_SOURCE })
  const journal = join(f.dir, 'runs.jsonl')
  const options = { journal, solverSource: process.env.METAACO_SOURCE, runtimeConfig: config.runtimeConfig, createRuntime: createOfflineRuntime, allowLlm: true }
  const result = await runExperiment(f.bank, ref, options)
  assert.equal(result.rows.length, 28)
  assert.equal(result.rows.filter(r => r.state === 'error' || r.state === 'unresolved').length, 0, JSON.stringify(result.rows.filter(r => r.reason)))
  for (const mode of ['fixed', 'metaaco-without-bank']) assert.equal(result.summary.find(r => r.mode === mode).successes, 4)
  assert.equal(result.summary.find(r => r.mode === 'cheapest').successes, 0)
  assert.ok(result.rows.every(r => r.costMicrounits === null))
  assert.equal(result.summary.find(r => r.mode === 'cheapest').totalCostMicrounits, null)
  for (const row of result.rows) {
    const attempt = f.bank.getAttempt(row.attemptId)
    assert.deepEqual(attempt.selection.feedback, config.feedback)
    const planned = f.bank.getEvents(row.attemptId).some(e => e.eventId === 'metaaco-dag-planning')
    assert.equal(planned, row.mode.startsWith('metaaco-'))
    if (row.mode === 'metaaco-without-bank') assert.equal(attempt.selection.selector.training.length, 0)
  }
  const lines = (await readFile(journal, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(lines.filter(r => r.type === 'result').length, 28)
  await assert.rejects(runExperiment(f.bank, ref, { ...options, journal: join(f.dir, 'other.jsonl') }), /already|replay/)
})
