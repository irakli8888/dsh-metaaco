import { routeQualityEvidence } from '../../src/orchestration/route-quality.js'
import { advanceFeedback, readFeedback } from '../../src/feedback/index.js'
import { readInspection, renderInspection } from '../../src/inspector/index.js'
import { runSkillAttempt } from '../../src/orchestration/skill-attempt.js'
import { armId } from '../../src/selector/contracts.js'
import { compileStrategies } from '../../src/strategy-templates.js'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import Engine from '@deepseek-ai/dsh-workflow-ptc'
import { fixture, snapshot, price } from '../fixtures/adaptive.js'
import { runAdaptiveAttempt } from '../../src/orchestration/index.js'
// Use the exact llm dependency already installed for dsh-agent, without installing another runtime.
const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent'))
const { LlmAdapter, LlmRuntime } = await import(require.resolve('@deepseek-ai/dsh-llm'))
import { runTemplateAttempt } from '../../src/orchestration/template-attempt.js'
for (const mode of ['success', 'failure', 'metaaco', 'template', 'template-failure', 'template-feedback', 'template-composed', 'skill-search', 'skill-review', 'skill-mixed-models', 'skill-components', 'skill-components-conflict']) test(`adaptive attempt through published Harness and LlmRuntime: ${mode}`, { skip: mode === 'metaaco' && !process.env.METAACO_SOURCE ? 'Set METAACO_SOURCE' : false }, async t => {
  let broken = mode.endsWith('failure')
  const f = fixture(t), calls = [], children = [], releases = []
  let disposed = false, planning = null
  if (mode === 'metaaco') {
    const problem = { version: 2, plan: f.plan, durationEstimatesSeconds: { green: 1, refactor: 1 } }
    const path = join(f.dir, 'problem.json'); writeFileSync(path, JSON.stringify(problem))
    const { stdout } = await promisify(execFile)('python3', ['-B', fileURLToPath(new URL('../../python/metaaco_dag.py', import.meta.url)), '--source', process.env.METAACO_SOURCE, '--problem', path], { timeout: 10000 })
    planning = { problem, result: JSON.parse(stdout) }
  }
  const components = mode.startsWith('skill-components')
  const conflict = mode === 'skill-components-conflict'
  const mixed = mode === 'skill-mixed-models'
  const skillReview = mode === 'skill-review' || mixed
  if (components) {
    f.plan.resources.agentSlots = 2
    f.policy.maxConcurrency = 2
    f.candidate.route.maxConcurrency = 2
    f.feedback = advanceFeedback(f.bank, { manifest: f.manifest, policy: f.policy,
      cutoff: '2000-01-01T00:00:00.000Z' })
  }
  if (mixed) {
    f.policy.allowedModels.push('offline/strong')
    f.candidate.route.models.push('offline/strong')
    f.feedback = advanceFeedback(f.bank, { manifest: f.manifest, policy: f.policy,
      cutoff: '2000-01-01T00:00:00.000Z' })
  }
  const skillSearch = mode === 'skill-search' || skillReview || components
  const run = skillSearch ? runSkillAttempt : mode.startsWith("template") ? runTemplateAttempt : runAdaptiveAttempt
  const learning = mode === "template-feedback"
  const composed = mode === 'template-composed'
  const templateOptions = {
    hints: { type: learning || composed ? 'feature' : 'bugfix' },
    compose: composed, resources: f.plan.resources, model: f.plan.tasks[0].model,
    budgetMicrounits: 20,
    estimates: Object.fromEntries(['design', 'implement', 'write-tests', 'integrate', 'refactor']
      .map(id => [id, { seconds: 1, costMicrounits: 4 }])),
  }
  const templateCandidates = { "direct-v1": f.candidate }
  if (learning) {
    const definition = f.bank.getStrategy(f.candidate.strategy.strategyId, 1)
    const strategy = f.bank.register({ ...definition, strategyId: "zz-contract" })
    templateCandidates["contract-v1"] = { ...f.candidate, strategy }
    broken = true
  }
  let composedId
  if (composed) {
    const spec = compileStrategies(f.request, { ...templateOptions, tdd: true })
    assert.equal(spec.variants.length, 4)
    const combined = spec.variants.find(({ problem }) => problem.plan.tasks.length === 5)
    composedId = combined.id
    const definition = f.bank.getStrategy(f.candidate.strategy.strategyId, 1)
    for (const { id } of spec.variants) {
      const strategy = f.bank.register({ ...definition, strategyId: id })
      templateCandidates[id] = { ...f.candidate, strategy }
    }
  }
  const options = {
    ...(skillSearch ? { candidate: f.candidate, budgetMicrounits: 20, resources: f.plan.resources,
      requiredSkills: skillReview ? ['analyze', 'review'] : [],
      skills: Object.fromEntries((components ? ['implement', 'implement-storage', 'implement-http', 'integrate', 'refactor'] : skillReview ? ['implement', 'refactor', 'analyze', 'review'] : ['implement', 'refactor', 'design']).map(id => [id, [{
        model: f.plan.tasks[0].model, seconds: components && id === 'implement' ? 12 : mixed && id === 'review' ? 8 : 1, costMicrounits: 4, prompt: id,
      }, ...(mixed && id === 'review' ? [{
        model: { provider: 'offline', model: 'strong' }, seconds: 1, costMicrounits: 8, prompt: id,
      }] : [])]])) } : {}),
    templateOptions,
    ...(composed ? { selectionMethod: { kind: 'fixed', armId: armId(templateCandidates[composedId]) } } : {}),
    templateCandidates, bank: f.bank, attemptId: 'integration', request: f.request,
    feedback: f.feedback, planning, candidates: [f.candidate], bindings: [f.binding], baseSnapshot: f.base, allowLlm: true,
    createRuntime: async ({ guardAdapter, signal }) => {
      const ctx = new Context()
      try {
        await ctx.plugin(LlmRuntime, {})
        class OfflineAdapter extends LlmAdapter {
          async *stream(options) {
            calls.push(options.model)
            yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 3 } }
            yield { type: 'finish', reason: { kind: 'stop' } }
          }
        }
        ctx.llm.registerAdapter(['offline'], guardAdapter(new OfflineAdapter(), options => ({ pricing: { ...price, model: options.model }, upperBoundMicrounits: 6 })))
        for (const name of ['session', 'session-projection', 'agent', 'system-prompt', 'fs-local', 'working-directory', 'subprocess-local', 'sandbox-local']) {
          await ctx.plugin((await import('@deepseek-ai/dsh-' + name)).default, {})
        }
        await ctx.plugin((await import('@deepseek-ai/dsh-sandbox-policy')).default, { mode: 'danger-full-access', workspaceRoot: process.cwd() })
        await ctx.plugin((await import('@deepseek-ai/dsh-ptc-runtime-node')).default, {})
        await ctx.plugin((await import('@deepseek-ai/dsh-subagent')).default, {})
        ctx.subagents.registerProvider({ name: 'offline', inheritsParentContext: false,
          capabilities: { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: false },
          async start(request) {
            const id = `child-${children.length}`, task = JSON.parse(request.prompt[0].text)
            children.push(task.task)
            if (skillReview && task.task === 'refactor') {
              assert.deepEqual(task.artifacts.map(artifact => artifact.name).sort(), ['implement', 'review'])
            }
            if (components && task.task === 'integrate') {
              assert.deepEqual(task.artifacts.map(artifact => artifact.name).sort(), ['implement-http', 'implement-storage'])
            }
            if (composed && task.task.startsWith('Combine')) {
              assert.deepEqual(task.artifacts.map(artifact => artifact.name).sort(), ['implement', 'write-tests'])
            }
            if (task.task === 'refactor' || task.task.startsWith('Refactor')) assert.ok(f.bank.getEvents(learning ? 'after-feedback' : 'integration').some(e => e.kind === 'evaluation-phase' && e.payload.phase === 'green'))
            const result = (async () => {
              const prepared = await ctx.llm.prepareCall({ provider: 'offline', model: mixed ? request.agentOptions.model : 'm' }, signal)
              for await (const chunk of prepared.stream({ ...prepared.config, messages: [], signal })) {
                if (chunk.type === 'finish' && chunk.reason.kind === 'error') throw new Error(chunk.reason.failure.message)
              }
              return { stopReason: 'completed', output: [{ type: 'text', text: JSON.stringify(components && task.task.startsWith('implement-')
                ? { revision: id, files: { [conflict ? 'shared.cjs' : task.task + '.cjs']: 'exports.ok = true' } }
                : snapshot(id, broken ? '0' : 'a+b')) }] }
            })()
            return { id, result, async dispose() { releases.push(id) } }
          } })
        await ctx.plugin(Engine, { provider: 'offline', maxConcurrentAgents: 1 })
        const session = ctx.sessions.create(undefined, { meta: { cwd: process.cwd() } })
        const parent = { id: session.id, ctx, session, options: {}, status: 'idle' }; ctx.agents.register(parent)
        return { ctx, parent, subagentProvider: 'offline', async dispose() { await ctx.fiber.dispose(); disposed = true } }
      } catch (error) { await ctx.fiber.dispose(); throw error }
    } }
  const result = await run(options)
  if (learning) {
    assert.equal(result.variantSelection.selectedId, 'direct-v1')
    assert.equal(result.attempt.state, 'failed')
    assert.equal(result.feedbackError, null)
    assert.notDeepEqual(result.feedback, f.feedback)
    broken = false
    children.length = 0
    const next = await run({ ...options, request: { ...f.request, taskId: 'heldout' },
      attemptId: 'after-feedback', feedback: result.feedback })
    assert.equal(next.variantSelection.fastestId, 'direct-v1')
    assert.equal(next.variantSelection.selectedId, 'contract-v1')
    assert.equal(next.attempt.state, 'succeeded')
    assert.deepEqual(next.feedback, result.feedback)
    assert.deepEqual(next.execution.tasks.map(task => task.id).sort(),
      ['design', 'implement', 'integrate', 'refactor', 'write-tests'])
    assert.equal(children.length, 5)
    return
  }
  if (mode.startsWith('template')) {
    assert.equal(result.variantSelection.selectedId, composedId ?? 'direct-v1')
    assert.ok(f.bank.exportJsonl().includes('template-selection'))
  }
  if (mode === 'skill-search') {
    assert.equal(result.skillSelection.choices.design, 'design/skip')
    const { snapshot: trained } = readFeedback(f.bank, result.feedback)
    const heldout = { ...f.request, taskId: 'heldout' }
    const evidence = routeQualityEvidence(f.bank, trained, heldout)
    assert.equal(evidence.length, 1)
    assert.equal(evidence[0].successes, 1)
    assert.equal(evidence[0].attempts, 1)
    assert.deepEqual(routeQualityEvidence(f.bank, trained, f.request), [])
    assert.equal(result.skillSelection.trace.evaluations.length, result.skillSelection.evaluations)
    assert.match(f.bank.exportJsonl(), /template-selection/)
    assert.deepEqual(result.execution.tasks.map(task => task.id), ['implement', 'refactor'])
    assert.ok(f.bank.exportJsonl().includes('template-selection'))
  }
  if (components) {
    assert.equal(result.skillSelection.choices.layout, 'components')
    if (conflict) {
      assert.equal(result.attempt.state, 'failed')
      assert.ok(result.execution.tasks.some(task => task.reason?.includes('Component file conflict')))
      assert.ok(!children.includes('integrate'))
      return
    }
    assert.ok(children.includes('integrate'))
  }
  assert.equal(result.attempt.state, broken ? 'failed' : 'succeeded')
  if (composed) {
    assert.equal(result.variantSelection.variants.length, 4)
    assert.deepEqual(result.execution.tasks.map(task => task.id).sort(),
      ['design', 'implement', 'integrate', 'refactor', 'write-tests'])
  }
  if (skillReview) {
    assert.deepEqual(result.execution.tasks.map(task => task.id), ['analyze', 'implement', 'review', 'refactor'])
  }
  if (mixed) {
    assert.deepEqual(calls, ['m', 'm', 'strong', 'm'])
    assert.ok(result.skillSelection.trace.evaluations.some(row => row.choices.review === 'review/0'))
    assert.ok(result.skillSelection.trace.evaluations.some(row => row.choices.review === 'review/1'))
    if (process.env.METAACO_MIXED_REPORT) {
      writeFileSync(process.env.METAACO_MIXED_REPORT, renderInspection(readInspection([f.dir])),
        { flag: 'wx', mode: 0o600 })
    }
  }
  assert.equal(calls.length, composed ? 5 : (skillReview || components) ? 4 : broken ? 1 : 2)
  assert.equal(releases.length, calls.length); assert.equal(disposed, true)
  assert.equal(result.attempt.outcome.measured.observedCallCount, calls.length)
  assert.equal(f.bank.getBudget('attempt/integration').spentMicrounits, 3 * calls.length)
})
