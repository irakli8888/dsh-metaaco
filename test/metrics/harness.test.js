import { test } from 'node:test'
import assert from 'node:assert/strict'
import { harnessCallRecord, runMeasuredWorkflow } from '../../src/adapters/harness/metrics.js'

test('Harness assistant settlements use last authoritative usage, never streaming sums', () => {
  const record = harnessCallRecord('session', { type: 'assistant/attempt', seq: 7, data: {
    turn: 1, step: 1, stream: [
      { type: 'chunk', time: 1, chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } } },
      { type: 'chunk', time: 2, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } } },
    ],
  } })
  assert.equal(record.usage.inputTokens, 10)
  assert.equal(record.status, 'failed'); assert.equal(record.usage.cacheReadTokens, null)
  assert.equal(record.requestId, null); assert.equal(record.pricing, null)
  const message = harnessCallRecord('session', { type: 'assistant/message', seq: 8, data: {
    interrupted: true, usage: { inputTokens: 3, outputTokens: 4 }, stream: [
      { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 999, outputTokens: 999 } } },
    ],
  } })
  assert.equal(message.usage.inputTokens, 3); assert.equal(message.status, 'cancelled')
  assert.notEqual(record.callId, message.callId)
})

test('workflow observation cannot start the engine without explicit consent', async () => {
  let starts = 0
  await assert.rejects(runMeasuredWorkflow({ workflowEngine: { start() { starts++ } } }, {}, {}, { collector: {} }), /allowLlm/)
  assert.equal(starts, 0)
})

test('listeners and timing are released when observer registration or the engine fails', async () => {
  for (const failRegistration of [false, true]) {
    let attached = 0, removed = 0
    const spans = []
    const ctx = { on() {
      if (failRegistration && attached === 2) throw Error('observer unavailable')
      attached++; return () => { removed++ }
    }, workflowEngine: { start() { throw Error('engine unavailable') } } }
    const collector = { startSpan() { spans.push('start') }, endSpan() { spans.push('end') } }
    const workflow = { name: 'offline', description: 'fixture', stages: [{ title: 'task', agents: [{ id: 'coder', prompt: 'test' }] }] }
    await assert.rejects(runMeasuredWorkflow(ctx, {}, workflow, { collector, allowLlm: true }), /unavailable/)
    assert.equal(removed, attached)
    assert.deepEqual(spans, ['start', 'end'])
  }
})
