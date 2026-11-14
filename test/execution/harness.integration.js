import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Engine from '@deepseek-ai/dsh-workflow-ptc'
import { StrategyBank } from '../../src/bank/index.js'
import { runDag } from '../../src/execution/index.js'

for (const mode of ['artifacts', 'failure', 'cancel']) test(`DAG through published Harness: ${mode}`, { timeout: 15000 }, async () => {
  const ctx = new Context(), dir = mkdtempSync(join(tmpdir(), 'dag-harness-'))
  const bank = new StrategyBank({ dataDir: join(dir, 'bank') })
  const children = [], disposed = [], controller = new AbortController()
  let active = 0, maxActive = 0, finishSlow
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
        else if (label === 'b' && mode === 'artifacts') finishSlow = finish
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
    const task = (id, dependsOn = [], inputs = []) => ({ id, prompt: id, dependsOn, inputs, slots: 1,
      model: { provider: 'offline-model-provider', model: 'fixture-model' } })
    const plan = { version: 3, execution: 'dag', name: 'fixture', description: 'offline',
      resources: { agentSlots: 2, maxArtifactBytes: 1024, maxInputBytes: 4096, timeoutMs: 10000 },
      tasks: [task('b'), task('a'), task('c', ['a'], [{ name: 'source', taskId: 'a' }])] }
    const execution = runDag(ctx, parent, plan, { allowLlm: true, bank, attemptId: 'dag', subagentProvider: 'offline', signal: controller.signal })
    if (mode === 'artifacts') {
      const report = await execution
      assert.equal(report.status, 'completed')
      assert.equal(children.length, 3)
      assert.equal(maxActive, 2)
      assert.equal(bank.getArtifact(report.tasks.find(n => n.id === 'c').artifact).toString(), 'c')
    } else {
      await assert.rejects(execution, e => e.report.status === (mode === 'cancel' ? 'cancelled' : 'failed'))
      assert.ok(children.every(c => c.label !== 'c'))
    }
    assert.equal(disposed.length, children.length)
    assert.equal(new Set(disposed).size, disposed.length)
    assert.ok(children.every(c => c.request.parent === parent))
    assert.ok(children.every(c => c.request.agentOptions.model === 'fixture-model'))
    assert.equal(bank.getAttempt('dag').state, 'running')
  } finally {
    try { await ctx.fiber.dispose() } finally { bank.close(); rmSync(dir, { recursive: true, force: true }) }
  }
})
