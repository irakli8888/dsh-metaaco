import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import Engine from '@deepseek-ai/dsh-workflow-ptc'
import { runWorkflow } from '../index.js'
import { runPlannedWorkflow } from '../planner.js'
import { StrategyBank } from '../src/bank/index.js'
import { MetricsCollector } from '../src/metrics/index.js'
import { runMeasuredWorkflow } from '../src/adapters/harness/metrics.js'

for (const mode of ['fixed', 'serial-order', 'start-groups', 'agent-problem']) test(`published 0.2.1-rc.2 offline execution (${mode})`, { timeout: 60000,
  skip: mode === 'agent-problem' && !process.env.METAACO_SOURCE ? 'Set METAACO_SOURCE for real Python → Harness test' : false,
}, async () => {
  let generatedPlan
  if (mode === 'agent-problem') {
    const { stdout } = await promisify(execFile)(process.env.METAACO_PYTHON || 'python3', [
      '-B', fileURLToPath(new URL('../python/metaaco_plan.py', import.meta.url)),
      '--source', process.env.METAACO_SOURCE,
      '--problem', fileURLToPath(new URL('../examples/agent-tasks.json', import.meta.url)),
    ], { timeout: 10000 })
    generatedPlan = JSON.parse(stdout)
    assert.equal(generatedPlan.resources.agentSlots, 2)
    assert.equal(generatedPlan.estimates.scheduleMakespan, 40)
  }
  const ctx = new Context()
  const cwd = await mkdtemp(join(tmpdir(), 'metaaco-'))
  let bank
  const children = [], events = [], release = []
  let active = 0, maxActive = 0
  const parallel = mode !== 'serial-order'
  try {
    for (const name of ['session', 'session-projection', 'agent', 'system-prompt', 'fs-local',
      'working-directory', 'subprocess-local', 'sandbox-local']) {
      await ctx.plugin((await import('@deepseek-ai/dsh-' + name)).default, {})
    }
    // Only the fixed, trusted plugin script executes. There is no model adapter.
    await ctx.plugin((await import('@deepseek-ai/dsh-sandbox-policy')).default,
      { mode: 'danger-full-access', workspaceRoot: cwd })
    await ctx.plugin((await import('@deepseek-ai/dsh-ptc-runtime-node')).default, {})
    await ctx.plugin((await import('@deepseek-ai/dsh-subagent')).default, {})
    ctx.subagents.registerProvider({
      name: 'offline', inheritsParentContext: false,
      capabilities: { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: false },
      async start(request) {
        const child = { id: `offline-${children.length + 1}`, request, disposed: false }
        if (children.length === 2) assert.equal(active, 0, 'join starts only after its predecessors finish')
        children.push(child)
        active++
        maxActive = Math.max(maxActive, active)
        const result = new Promise(resolve => {
          const finish = () => {
            active--
            resolve({ output: [{ type: 'text', text: child.id }], stopReason: 'completed' })
          }
          if (parallel && children.length <= 2) {
            release.push(finish)
            if (release.length === 2) release.forEach(fn => fn())
          } else finish()
        })
        return { id: child.id, result,
          async dispose() { child.disposed = true },
        }
      },
    })
    await ctx.plugin(Engine, { provider: 'offline', maxConcurrentAgents: mode === 'agent-problem' ? 4 : 2 })
    const session = ctx.sessions.create(undefined, { meta: { cwd } })
    const parent = { id: session.id, ctx, session, options: {}, status: 'idle' }
    ctx.agents.register(parent)
    ctx.on('workflow/agent-start', (_run, agent) => {
      events.push(agent.childId)
      if (mode === 'fixed') {
        // Publish only after the external child identity has been admitted by the registry.
        // This listener runs before the metrics child-start observer, exercising its buffer.
        const childSession = ctx.sessions.create(agent.childId, { meta: { cwd } })
        childSession.append('assistant/attempt', { turn: 1, step: 1, stream: [
          { type: 'chunk', time: Date.now(), chunk: { type: 'usage', usage: {
            inputTokens: 5, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 8,
          } } },
        ] })
      }
    })
    const workflow = JSON.parse(await readFile(new URL('../examples/two-agents.json', import.meta.url)))
    let result
    if (mode === 'fixed') {
      bank = new StrategyBank({ dataDir: join(cwd, 'history') })
      const strategy = bank.register({ schemaVersion: 1, strategyId: 'fixed', version: 1,
        workflow, provenance: { source: 'integration-test', harness: '0.2.1-rc.2' } })
      bank.beginAttempt({ attemptId: 'offline-attempt', strategy,
        request: { schemaVersion: 1, taskId: 'offline-task', description: 'Harness smoke test',
          repo: cwd, baseCommit: 'offline-fixture', testSpec: {}, provenance: { source: 'integration-test' } },
        selection: { policy: 'fixed' } })
      const metrics = new MetricsCollector({ bank, attemptId: 'offline-attempt' })
      result = await runMeasuredWorkflow(ctx, parent, workflow, { subagentProvider: 'offline', collector: metrics, allowLlm: true })
      bank.appendEvent('offline-attempt', 'workflow-result', { kind: 'workflow-completed', payload: result })
      const artifact = bank.putArtifact(Buffer.from(JSON.stringify(result.result)))
      bank.attachArtifact('offline-attempt', 'agent-outputs', artifact)
      metrics.finish('completed')
      const outcome = metrics.snapshot()
      assert.equal(outcome.measured.observedCallCount, 2)
      assert.equal(outcome.measured.knownUsage.inputTokens, 10)
      assert.equal(outcome.measured.usage.inputTokens, null, 'observer cannot assert complete model coverage')
      assert.equal(outcome.measured.spans.agent.count, 2)
      assert.ok(outcome.measured.spans.workflow.sumMs >= 0)
      bank.finalizeAttempt('offline-attempt', { status: 'inconclusive', requiredTests: [],
        provenance: { source: 'integration-test', reason: 'Agent replies do not establish code correctness' } },
      outcome)
      assert.equal(bank.getAttempt('offline-attempt').state, 'inconclusive')
      assert.deepEqual(JSON.parse(bank.getArtifact(artifact)), result.result)
      assert.equal(bank.getEvents('offline-attempt').find(e => e.kind === 'workflow-completed').payload.runId, result.runId)
    } else if (generatedPlan) {
      result = await runPlannedWorkflow(ctx, parent, generatedPlan, { allowLlm: true, subagentProvider: 'offline' })
    } else {
      const stages = mode === 'serial-order'
        ? workflow.stages[0].agents.map((task, i) => ({ title: `Job ${i}`, agents: [task] }))
        : [...workflow.stages, { title: 'Join', agents: [{ id: 'join', prompt: 'join' }] }]
      result = await runPlannedWorkflow(ctx, parent, { version: 1, planner: 'python-metaaco',
        execution: mode, workflow: { ...workflow, stages } }, { allowLlm: true, subagentProvider: 'offline' })
    }
    const expected = ['start-groups', 'agent-problem'].includes(mode) ? 3 : 2
    assert.equal(result.agentsStarted, expected)
    const expectedValues = generatedPlan
      ? Object.fromEntries(generatedPlan.workflow.stages.flatMap(stage => stage.agents)
        .map((task, i) => [task.id, `offline-${i + 1}`]))
      : { java: 'offline-1', aco: 'offline-2', ...(mode === 'start-groups' ? { join: 'offline-3' } : {}) }
    assert.deepEqual(result.result, expectedValues)
    assert.equal(events.length, expected)
    assert.equal(children.length, expected)
    assert.equal(maxActive, parallel ? 2 : 1)
    assert.ok(children.every(child => child.disposed))
    assert.ok(children.every(child => child.request.parent === parent))
  } finally {
    try { await ctx.fiber.dispose() } finally {
      bank?.close()
      await rm(cwd, { recursive: true, force: true })
    }
  }
})
