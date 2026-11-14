import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as smoke from '../../examples/deepseek-smoke.js'

test('preview, insufficient budget and missing key never dispatch', async () => {
  const fetchImpl = () => assert.fail('Unexpected dispatch')
  const preview = await smoke.runSmoke({ fetchImpl })
  assert.equal(preview.upperBoundMicrounits, 300020)
  await assert.rejects(smoke.runSmoke({ execute: true, budget: 1, key: 'fixture', fetchImpl }), /budget/i)
  await assert.rejects(smoke.runSmoke({ execute: true, budget: 300020, fetchImpl }), /key/i)
})

test('one request reports disjoint usage and does not retry HTTP failures', async () => {
  let calls = 0
  const options = { execute: true, budget: 300020, key: 'fixture', fetchImpl: async (url, req) => {
    calls++
    assert.equal(url, 'https://api.deepseek.com/chat/completions')
    assert.equal(req.redirect, 'error')
    assert.equal(JSON.parse(req.body).max_tokens, 16)
    return new Response(JSON.stringify({ model: 'deepseek-flash', choices: [{ finish_reason: 'stop', message: { content: 'OK' } }],
      usage: { prompt_tokens: 12, prompt_cache_miss_tokens: 10, prompt_cache_hit_tokens: 2, completion_tokens: 1, total_tokens: 13 } }))
  } }
  assert.equal((await smoke.runSmoke(options)).estimatedPeakCostMicrounits, 5)
  assert.equal(calls, 1)
  await assert.rejects(smoke.runSmoke({ ...options, fetchImpl: async () => { calls++; return new Response('', { status: 429 }) } }), /429/)
  assert.equal(calls, 2)
})
