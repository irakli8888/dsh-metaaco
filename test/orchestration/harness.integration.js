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
for (const mode of ['success', 'failure', 'metaaco', 'template', 'template-failure']) test(`adaptive attempt through published Harness and LlmRuntime: ${mode}`, { skip: mode === 'metaaco' && !process.env.METAACO_SOURCE ? 'Set METAACO_SOURCE' : false }, async t => {
  const broken = mode.endsWith('failure')
  const f = fixture(t), calls = [], children = [], releases = []
  let disposed = false, planning = null
  if (mode === 'metaaco') {
    const problem = { version: 2, plan: f.plan, durationEstimatesSeconds: { green: 1, refactor: 1 } }
    const path = join(f.dir, 'problem.json'); writeFileSync(path, JSON.stringify(problem))
    const { stdout } = await promisify(execFile)('python3', ['-B', fileURLToPath(new URL('../../python/metaaco_dag.py', import.meta.url)), '--source', process.env.METAACO_SOURCE, '--problem', path], { timeout: 10000 })
    planning = { problem, result: JSON.parse(stdout) }
  }
  const run = mode.startsWith("template") ? runTemplateAttempt : runAdaptiveAttempt
  const result = await run({
    templateOptions: { hints: { type: "bugfix" }, resources: f.plan.resources, model: f.plan.tasks[0].model,
      budgetMicrounits: 20, estimates: { implement: { seconds: 1, costMicrounits: 6 }, refactor: { seconds: 1, costMicrounits: 6 } } },
    templateCandidates: { "direct-v1": f.candidate }, bank: f.bank, attemptId: 'integration', request: f.request,
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
        ctx.llm.registerAdapter(['offline'], guardAdapter(new OfflineAdapter(), () => ({ pricing: price, upperBoundMicrounits: 6 })))
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
            if (task.task === 'refactor' || task.task.startsWith('Refactor')) assert.ok(f.bank.getEvents('integration').some(e => e.kind === 'evaluation-phase' && e.payload.phase === 'green'))
            const result = (async () => {
              const prepared = await ctx.llm.prepareCall({ provider: 'offline', model: 'm' }, signal)
              for await (const chunk of prepared.stream({ ...prepared.config, messages: [], signal })) {
                if (chunk.type === 'finish' && chunk.reason.kind === 'error') throw new Error(chunk.reason.failure.message)
              }
              return { stopReason: 'completed', output: [{ type: 'text', text: JSON.stringify(snapshot(id, broken ? '0' : 'a+b')) }] }
            })()
            return { id, result, async dispose() { releases.push(id) } }
          } })
        await ctx.plugin(Engine, { provider: 'offline', maxConcurrentAgents: 1 })
        const session = ctx.sessions.create(undefined, { meta: { cwd: process.cwd() } })
        const parent = { id: session.id, ctx, session, options: {}, status: 'idle' }; ctx.agents.register(parent)
        return { ctx, parent, subagentProvider: 'offline', async dispose() { await ctx.fiber.dispose(); disposed = true } }
      } catch (error) { await ctx.fiber.dispose(); throw error }
    } })
  if (mode.startsWith('template')) {
    assert.equal(result.variantSelection.selectedId, 'direct-v1')
    assert.ok(f.bank.exportJsonl().includes('template-selection'))
  }
  assert.equal(result.attempt.state, broken ? 'failed' : 'succeeded')
  assert.equal(calls.length, broken ? 1 : 2)
  assert.equal(releases.length, calls.length); assert.equal(disposed, true)
  assert.equal(result.attempt.outcome.measured.observedCallCount, calls.length)
  assert.equal(f.bank.getBudget('attempt/integration').spentMicrounits, 3 * calls.length)
})
