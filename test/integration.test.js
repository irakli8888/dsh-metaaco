import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Engine from '@deepseek-ai/dsh-workflow-ptc'
import { runWorkflow } from '../index.js'
import { runPlannedWorkflow } from '../planner.js'

for (const mode of ['fixed', 'serial-order', 'start-groups']) test(`published 0.2.1-rc.2 offline execution (${mode})`, { timeout: 60000 }, async () => {
  const ctx = new Context()
  const cwd = await mkdtemp(join(tmpdir(), 'metaaco-'))
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
    await ctx.plugin(Engine, { provider: 'offline', maxConcurrentAgents: 2 })
    const session = ctx.sessions.create(undefined, { meta: { cwd } })
    const parent = { id: session.id, ctx, session, options: {}, status: 'idle' }
    ctx.agents.register(parent)
    ctx.on('workflow/agent-start', (_run, agent) => events.push(agent.childId))
    const workflow = JSON.parse(await readFile(new URL('../examples/two-agents.json', import.meta.url)))
    let result
    if (mode === 'fixed') {
      result = await runWorkflow(ctx, parent, workflow, { subagentProvider: 'offline' })
    } else {
      const stages = mode === 'serial-order'
        ? workflow.stages[0].agents.map((task, i) => ({ title: `Job ${i}`, agents: [task] }))
        : [...workflow.stages, { title: 'Join', agents: [{ id: 'join', prompt: 'join' }] }]
      result = await runPlannedWorkflow(ctx, parent, { version: 1, planner: 'python-metaaco',
        execution: mode, workflow: { ...workflow, stages } }, { allowLlm: true, subagentProvider: 'offline' })
    }
    const expected = mode === 'start-groups' ? 3 : 2
    assert.equal(result.agentsStarted, expected)
    assert.deepEqual(result.result, { java: 'offline-1', aco: 'offline-2',
      ...(mode === 'start-groups' ? { join: 'offline-3' } : {}) })
    assert.equal(events.length, expected)
    assert.equal(children.length, expected)
    assert.equal(maxActive, parallel ? 2 : 1)
    assert.ok(children.every(child => child.disposed))
    assert.ok(children.every(child => child.request.parent === parent))
  } finally {
    await ctx.fiber.dispose()
    await rm(cwd, { recursive: true, force: true })
  }
})
