import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runDeepSeekTdd, requiredBudget } from '../../examples/run-deepseek-tdd.js'

import { runDeepSeekTemplate } from '../../examples/run-deepseek-template.js'

for (const run of [runDeepSeekTdd, runDeepSeekTemplate]) test(`DeepSeek wire fixtures through ${run.name}`, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'deepseek-tdd-'))
  t.after(() => rm(dir, { force: true, recursive: true }))
  let calls = 0
  const result = await run({ out: join(dir, 'bank'), budget: requiredBudget, dockerImage: process.env.TEST_EVALUATION_IMAGE,
    key: 'fixture', execute: true, fetchImpl: async (_, req) => {
      calls++
      if (calls === 2) assert.match(JSON.parse(req.body).messages[0].content, /subject.cjs/)
      const content = JSON.stringify({ revision: 'phase-' + calls, files: { 'subject.cjs': 'exports.solve=(a,b)=>a+b;' } })
      return Response.json({ model: 'deepseek-flash', choices: [{ finish_reason: 'stop', message: { content } }],
        usage: { prompt_tokens: 12, prompt_cache_miss_tokens: 10, prompt_cache_hit_tokens: 2, completion_tokens: 1, total_tokens: 13 } })
    } })
  assert.equal(calls, 2, JSON.stringify(result))
  assert.equal(result.state, 'succeeded')
  assert.equal(result.budget.spentMicrounits, 10)
})
