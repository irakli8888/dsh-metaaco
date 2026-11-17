import { createDeepSeekAdapter } from '../../src/adapters/harness/deepseek.js'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../../index.js'
import { advanceFeedback } from '../../src/feedback/index.js'
import { createTextRuntime } from '../../examples/offline-runtime.js'
import { fixture, snapshot } from '../fixtures/adaptive.js'

const image = process.env.TEST_EVALUATION_IMAGE
test('skill slash command executes through Harness and Docker with mocked API', { skip: !image && 'Set TEST_EVALUATION_IMAGE' }, async t => {
  const f = fixture(t)
  const model = { provider: 'deepseek', model: 'deepseek-flash' }
  const candidate = { ...f.candidate, route: { ...f.candidate.route, models: ['deepseek/deepseek-flash'] } }
  const feedback = advanceFeedback(f.bank, { manifest: f.manifest, cutoff: '2000-01-01T00:00:00.000Z',
    policy: { ...f.policy, allowedModels: candidate.route.models, maxCostMicrounits: 602458, maxWallTimeMs: 90000 } })
  f.request.testSpec.timeoutMs = 15000
  const path = join(f.dir, 'job.json')
  const route = prompt => [{ model, costMicrounits: 301229, seconds: 1, prompt }]
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, request: f.request, baseSnapshot: f.base,
    candidate, feedback, bankDir: f.dir, evaluationDockerImage: image, budgetMicrounits: 602458,
    resources: f.plan.resources, skills: { implement: route('implement'), refactor: route('refactor') } }))
  const before = process.env.DEEPSEEK_API_KEY
  process.env.DEEPSEEK_API_KEY = 'fixture'
  t.after(() => { if (before === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = before })
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(JSON.parse(options.body).model, model.model)
    return Response.json({ model: model.model,
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(snapshot(`step-${++calls}`)) } }],
      usage: { prompt_tokens: 4, prompt_cache_miss_tokens: 3, prompt_cache_hit_tokens: 1, completion_tokens: 1, total_tokens: 5 } })
  })
  const runtime = await createTextRuntime({ provider: 'unused', guardAdapter: adapter => adapter,
    createAdapter: () => createDeepSeekAdapter({ key: 'fixture' }), promptFor: () => '' })
  try {
    let command
    apply({ commands: { register(value) { command = value } }, subagents: runtime.ctx.subagents,
      workflowEngine: runtime.ctx.workflowEngine }, { skillJobFile: path })
    const invoke = rawInput => command.handler({ rawInput, agent: runtime.parent })
    assert.equal((await invoke('')).kind, 'success')
    assert.equal(calls, 0)
    const response = await invoke('--allow-llm')
    assert.equal(response.kind, 'success', response.text)
    assert.equal(calls, 2)
    assert.equal(f.bank.getAttempt(JSON.parse(response.text).attemptId).state, 'succeeded')
  } finally { await runtime.dispose() }
})
