import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runLiveScheduling } from '../../examples/live-scheduling.js'

test('live scheduling requires consent and shares a bounded ledger across paired runs', { timeout: 30000 }, async () => {
  let calls = 0
  const fetchImpl = async (_url, options) => {
    calls++
    const body = JSON.parse(options.body)
    const envelope = JSON.parse(body.messages[0].content.split('\n').at(-1))
    const task = JSON.parse(envelope.task)
    if (task.id === 'tests') assert.ok(envelope.artifacts[0].content.includes('expression'))
    return { ok: true, json: async () => ({ model: 'deepseek-flash', usage: {
      prompt_cache_miss_tokens: 10, prompt_cache_hit_tokens: 0, prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ taskId: task.id, ...({ patch: { expression: 'a + b' }, review: { findings: ['zero', 'negative', 'fraction'] }, docs: { summary: 'addition', examples: [] }, tests: { cases: [{a:0,b:0,result:0},{a:1,b:2,result:3},{a:-1,b:1,result:0}] } }[task.id]) }) } }] }) }
  }
  const directory = mkdtempSync(join(tmpdir(), 'live-schedule-'))
  try {
    await assert.rejects(runLiveScheduling({ directory, key: 'fixture', fetchImpl, budgetMicrounits: 800000 }), /consent/)
    assert.equal(calls, 0)
    const result = await runLiveScheduling({ directory: join(directory, 'run'), key: 'fixture', fetchImpl,
      budgetMicrounits: 800000, execute: true, seeds: [7] })
    assert.equal(calls, 8)
    assert.equal(result.runs.length, 2)
    assert.equal(result.budget.heldMicrounits, 0)
    assert.equal(result.budget.spentMicrounits, 120)
    for (const run of result.runs) {
      assert.equal(run.execution.status, 'completed')
      assert.equal(run.execution.quality, 'inconclusive')
      assert.equal(run.metrics.measured.observedCallCount, 4)
    }
    await assert.rejects(runLiveScheduling({ directory: join(directory, 'run'), key: 'fixture', fetchImpl,
      budgetMicrounits: 800000, execute: true, seeds: [7] }))
    assert.equal(calls, 8)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('failed API calls retain reservations and stop the series without retries', { timeout: 15000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'live-schedule-fail-'))
  let calls = 0
  try {
    await assert.rejects(runLiveScheduling({ directory: join(directory, 'run'), key: 'fixture', execute: true,
      budgetMicrounits: 602458, seeds: [7], fetchImpl: async () => { calls++; throw new Error('fixture network failure') } }), /Series stopped/)
    const { readFileSync } = await import('node:fs')
    const report = JSON.parse(readFileSync(join(directory, 'run/report.json')))
    assert.equal(report.stopped, true)
    assert.equal(report.runs.length, 1)
    assert.equal(calls, 2)
    assert.equal(report.budget.heldMicrounits, 602458)
    assert.equal(report.budget.spentMicrounits, 0)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
