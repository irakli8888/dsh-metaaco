import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runPricingStudy } from '../../examples/run-pricing-study.js'
import { pricingStudyTask } from '../../examples/pricing-study-task.js'

test('both pricing templates share a budget and record training outcomes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pricing-study-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const repoDirectory = process.cwd()
  const { baseSnapshot, editablePaths: [path] } = pricingStudyTask(repoDirectory)
  const code = `
export function calculateCostRange(usage, price, bounds) {
  const counts = normalizeUsage(usage);
  const min = {}, max = {};
  for (const field of billedFields) {
    min[field] = counts[field] ?? 0;
    max[field] = counts[field] ?? bounds[field] ?? null;
  }
  return { currency: price.currency, minMicrounits: calculateCost(min, price).microunits,
    maxMicrounits: calculateCost(max, price).microunits };
}
`
  let calls = 0
  const result = await runPricingStudy({ repoDirectory, out: join(dir, 'bank'), execute: true,
    key: 'fixture', budget: 2108603, fetchImpl: async (_, req) => {
      const prompt = JSON.parse(req.body).messages[0].content
      const envelope = JSON.parse(prompt.split('\n').at(-1))
      if (envelope.task.startsWith('Refactor')) {
        assert.match(envelope.task, /export function calculateCostRange/)
        assert.deepEqual(envelope.artifacts, [])
      }
      const before = baseSnapshot.files[path].trimEnd().split('\n').slice(-2).join('\n')
      const edits = envelope.task.startsWith('Refactor') ? [] : [{ path, before, after: before + code }]
      calls++
      const isTest = envelope.task.startsWith('Draft tests')
      if (isTest) assert.match(prompt, /Exactly three test ideas/)
      const content = JSON.stringify(isTest ? { cases: ['Known usage', 'Bounded usage', 'Unknown maximum'] }
        : { revision: `response-${calls}`, edits })
      return Response.json({ model: 'deepseek-flash', choices: [{ finish_reason: 'stop', message: { content } }],
        usage: { prompt_tokens: 12, prompt_cache_miss_tokens: 10, prompt_cache_hit_tokens: 2, completion_tokens: 1, total_tokens: 13 } })
    } })
  assert.deepEqual(result.runs.map(run => run.state), ['succeeded', 'succeeded'])
  assert.equal(calls, 7)
  assert.equal(result.budget.spentMicrounits, 35)
  assert.equal(result.budget.heldMicrounits, 0)
})
