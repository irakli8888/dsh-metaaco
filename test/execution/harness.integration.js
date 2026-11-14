import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Engine from '@deepseek-ai/dsh-workflow-ptc'
import { StrategyBank } from '../../src/bank/index.js'
import { validateMetaacoDag } from '../../src/planning/index.js'
import { runMeasuredDag, runMeasuredMetaacoDag } from '../../src/adapters/harness/dag-metrics.js'
import { MetricsCollector } from '../../src/metrics/index.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

for (const mode of ['artifacts', 'failure', 'cancel', 'metaaco']) test(`DAG through published Harness: ${mode}`, {
  timeout: 15000, skip: mode === 'metaaco' && !process.env.METAACO_SOURCE ? 'Set METAACO_SOURCE for real solver' : false,
}, async () => {
  const ctx = new Context(), dir = mkdtempSync(join(tmpdir(), 'dag-harness-'))
  const bank = new StrategyBank({ dataDir: join(dir, 'bank') })
  const children = [], disposed = [], controller = new AbortController()
  let active = 0, maxActive = 0, finishSlow, finishFast
  try {
    for (const name of ['session', 'session-projection', 'agent', 'system-prompt', 'fs-local',
      'working-directory', 'subprocess-local', 'sandbox-local']) {
      await ctx.plugin((await import('@deepseek-ai/dsh-' + name)).default, {})
    }
    await ctx.plugin((await import('@deepseek-ai/dsh-sandbox-policy')).default,
      { mode: 'danger-full-access', workspaceRoot: dir })
    await ctx.plugin((await import('@deepseek-ai/dsh-ptc-runtime-node')).default, {})
    await ctx.plugin((await import('@deepseek-ai/dsh-subagent')).default, {})
    ctx.subagents.registerProvider({ name: 'offline', inheritsParentContext: false,
      capabilities: { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: false },
      async start(request) {
        const envelope = JSON.parse(request.prompt[0].text)
        const label = envelope.task
        children.push({ label, request }); active++; maxActive = Math.max(maxActive, active)
        const id = `offline-${children.length}`
        let resolve
        const result = new Promise(r => { resolve = r })
        const finish = () => resolve({ stopReason: mode === 'failure' && label === 'a' ? 'error' : 'completed',
          output: [{ type: 'text', text: label === 'a' ? 'source text with "quotes" and ${data}' : label }] })
        if (mode === 'cancel') queueMicrotask(() => controller.abort())
        else if (label === 'b' && ['artifacts', 'metaaco'].includes(mode)) { finishSlow = finish; finishFast?.() }
        else if (label === 'a' && ['artifacts', 'metaaco'].includes(mode) && !finishSlow) finishFast = finish
        else if (label === 'c') {
          assert.equal(envelope.artifacts[0].content, 'source text with "quotes" and ${data}')
          assert.equal(envelope.artifacts[0].producer, 'a')
          assert.ok(finishSlow, 'independent root is still active')
          finishSlow(); finish()
        } else finish()
        return { id, result, async dispose() { disposed.push(id); active--; resolve({ stopReason: 'cancelled', output: [] }) } }
      },
    })
    await ctx.plugin(Engine, { provider: 'offline', maxConcurrentAgents: 1 })
    const session = ctx.sessions.create(undefined, { meta: { cwd: dir } })
    const parent = { id: session.id, ctx, session, options: {}, status: 'idle' }
    ctx.agents.register(parent)
    const strategy = bank.register({ schemaVersion: 1, strategyId: 'fixture', version: 1, provenance: {},
      workflow: { name: 'fixture', description: 'offline', stages: [{ title: 'code', agents: [{ id: 'coder', prompt: 'code' }] }] } })
    bank.beginAttempt({ attemptId: 'dag', strategy, selection: {}, request: { schemaVersion: 1, taskId: 'fixture',
      description: 'offline', repo: dir, baseCommit: 'fixture', testSpec: {}, provenance: {} } })
    const collector = new MetricsCollector({ bank, attemptId: 'dag' })
    const observedTasks = new Set()
    // Registered before the observer, so settlements arrive before its child-ownership callback.
    ctx.on('workflow/agent-start', (_run, info) => {
      const childSession = ctx.sessions.create(info.childId, { meta: { cwd: dir } })
      childSession.append('assistant/attempt', { turn: 1, step: 1, stream: [
        { type: 'chunk', time: Date.now(), chunk: { type: 'usage', usage: {
          inputTokens: 5, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 8,
        } } },
      ] })
    })
    const task = (id, dependsOn = [], inputs = []) => ({ id, prompt: id, dependsOn, inputs, slots: 1,
      model: { provider: 'offline-model-provider', model: 'fixture-model' } })
    const plan = { version: 3, execution: 'dag', name: 'fixture', description: 'offline',
      resources: { agentSlots: 2, maxArtifactBytes: 1024, maxInputBytes: 4096, timeoutMs: 10000 },
      tasks: [task('b'), task('a'), task('c', ['a'], [{ name: 'source', taskId: 'a' }])] }
    const options = { allowLlm: true, bank, attemptId: 'dag', collector, subagentProvider: 'offline', signal: controller.signal,
      routeForEvent(_session, _event, owner) { observedTasks.add(owner.taskId); return null } }
    let execution
    if (mode === 'metaaco') {
      plan.description = 'Проверка реального MetaACO → DAG'
      const problem = { version: 2, plan, durationEstimatesSeconds: { a: 10, b: 30, c: 10 } }
      const input = join(dir, 'problem.json')
      writeFileSync(input, JSON.stringify(problem))
      const { stdout } = await promisify(execFile)(process.env.METAACO_PYTHON || 'python3', [
        '-B', fileURLToPath(new URL('../../python/metaaco_dag.py', import.meta.url)),
        '--source', process.env.METAACO_SOURCE, '--problem', input, '--seed', '42',
      ], { timeout: 10000 })
      const result = validateMetaacoDag(JSON.parse(stdout), problem)
      assert.equal(result.estimates.scheduleMakespan, 30)
      assert.equal(result.estimates.executionMakespan, null)
      execution = runMeasuredMetaacoDag(ctx, parent, result, problem, options)
    } else execution = runMeasuredDag(ctx, parent, plan, options)
    if (['artifacts', 'metaaco'].includes(mode)) {
      const report = await execution
      assert.equal(report.status, 'completed')
      assert.equal(children.length, 3)
      assert.equal(maxActive, 2)
      assert.equal(bank.getArtifact(report.tasks.find(n => n.id === 'c').artifact).toString(), 'c')
      if (mode === 'metaaco') {
        const planning = bank.getEvents('dag').find(e => e.kind === 'metaaco-dag-planning-v1')
        assert.equal(JSON.parse(bank.getArtifact(planning.payload.artifact)).planner, 'python-metaaco-dag')
      }
    } else {
      await assert.rejects(execution, e => e.report.status === (mode === 'cancel' ? 'cancelled' : 'failed'))
      assert.ok(children.every(c => c.label !== 'c'))
    }
    assert.equal(disposed.length, children.length)
    assert.equal(new Set(disposed).size, disposed.length)
    assert.ok(children.every(c => c.request.parent === parent))
    assert.ok(children.every(c => c.request.agentOptions.model === 'fixture-model'))
    assert.equal(bank.getAttempt('dag').state, 'running')
    collector.finish(mode === 'cancel' ? 'cancelled' : mode === 'failure' ? 'failed' : 'completed')
    const metrics = collector.snapshot()
    assert.equal(metrics.measured.coverageComplete, false)
    assert.equal(metrics.measured.usage.inputTokens, null)
    if (mode !== 'cancel') {
      assert.equal(metrics.measured.observedCallCount, children.length)
      assert.equal(metrics.measured.knownUsage.inputTokens, children.length * 5)
      assert.equal(observedTasks.size, children.length)
    }
  } finally {
    try { await ctx.fiber.dispose() } finally { bank.close(); rmSync(dir, { recursive: true, force: true }) }
  }
})
