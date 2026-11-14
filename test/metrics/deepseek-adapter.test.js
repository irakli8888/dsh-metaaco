import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as api from '../../src/adapters/harness/deepseek.js'

test('guard quote bounds the exact DeepSeek request and maps billable usage', async () => {
  let calls = 0
  const { adapter, quote } = api.createDeepSeekAdapter({ key: 'fixture', fetchImpl: async (_, options) => {
    calls++
    const body = JSON.parse(options.body)
    assert.equal(body.max_tokens, 1024)
    assert.deepEqual(body.response_format, { type: 'json_object' })
    assert.equal(body.messages[0].content, 'Implement addition')
    return Response.json({ model: 'deepseek-flash', choices: [{ finish_reason: 'stop', message: { content: '{}' } }],
      usage: { prompt_tokens: 12, prompt_cache_miss_tokens: 10, prompt_cache_hit_tokens: 2, completion_tokens: 1, total_tokens: 13 } })
  } })
  const options = { provider: 'deepseek', model: 'deepseek-flash', system: 'Implement addition', messages: [] }
  assert.equal(quote(options).upperBoundMicrounits, 301229)
  assert.throws(() => quote({ ...options, tools: [{ name: 'shell' }] }), /unsupported/i)
  const chunks = await Array.fromAsync(adapter.stream(options))
  assert.equal(chunks.find(chunk => chunk.type === 'usage').usage.inputTokens, 10)
  assert.equal(calls, 1)
})
