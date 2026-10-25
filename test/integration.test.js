import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Engine from '@deepseek-ai/dsh-workflow-ptc'
import { runWorkflow } from '../index.js'

test('published 0.2.1-rc.2 engine runs two offline provider children', { timeout: 60000 }, async () => {
  const ctx = new Context()
  const cwd = await mkdtemp(join(tmpdir(), 'metaaco-'))
  const children = [], events = []
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
        children.push(child)
        return { id: child.id,
          result: Promise.resolve({ output: [{ type: 'text', text: child.id }], stopReason: 'completed' }),
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
    const result = await runWorkflow(ctx, parent, workflow, { subagentProvider: 'offline' })
    assert.equal(result.agentsStarted, 2)
    assert.deepEqual(result.result, { java: 'offline-1', aco: 'offline-2' })
    assert.equal(events.length, 2)
    assert.equal(children.length, 2)
    assert.ok(children.every(child => child.disposed))
    assert.ok(children.every(child => child.request.parent === parent))
  } finally {
    await ctx.fiber.dispose()
    await rm(cwd, { recursive: true, force: true })
  }
})
