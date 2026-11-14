// Deliberately synthetic model outputs. Real Harness/LlmRuntime; no network adapter or credentials.
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import Engine from '@deepseek-ai/dsh-workflow-ptc'
const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent'))
const { LlmAdapter, LlmRuntime } = await import(require.resolve('@deepseek-ai/dsh-llm'))

export async function createOfflineRuntime({ guardAdapter, signal, runtimeConfig, experimentCell }) {
  const ctx = new Context()
  try {
    await ctx.plugin(LlmRuntime, {})
    class OfflineAdapter extends LlmAdapter {
      async *stream(options) {
        signal?.throwIfAborted()
        const { phase } = JSON.parse(options.system)
        const fixture = runtimeConfig.fixtures[experimentCell.taskId]
        const value = options.model === 'good' ? fixture[phase] : fixture.broken
        yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(value) } }
        yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 3 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['offline'], guardAdapter(new OfflineAdapter(), options => ({
      pricing: runtimeConfig.prices[options.model], upperBoundMicrounits: 10,
    })))
    for (const name of ['session', 'session-projection', 'agent', 'system-prompt', 'fs-local', 'working-directory', 'subprocess-local', 'sandbox-local']) {
      await ctx.plugin((await import('@deepseek-ai/dsh-' + name)).default, {})
    }
    await ctx.plugin((await import('@deepseek-ai/dsh-sandbox-policy')).default, { mode: 'danger-full-access', workspaceRoot: process.cwd() })
    await ctx.plugin((await import('@deepseek-ai/dsh-ptc-runtime-node')).default, {})
    await ctx.plugin((await import('@deepseek-ai/dsh-subagent')).default, {})
    ctx.subagents.registerProvider({ name: 'offline', inheritsParentContext: false,
      capabilities: { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: false },
      async start(request) {
        const envelope = JSON.parse(request.prompt[0].text)
        const phase = JSON.parse(envelope.task).phase
        const result = (async () => {
          const model = request.agentOptions?.model
          // Harness places agent options in request.agentOptions; reject unknown routing explicitly.
          if (!model) throw new Error('Offline child model missing')
          const prepared = await ctx.llm.prepareCall({ provider: 'offline', model }, signal)
          let output = ''
          for await (const chunk of prepared.stream({ ...prepared.config, messages: [], system: JSON.stringify({ phase }), signal })) {
            if (chunk.type === 'block-end') output += chunk.block.text ?? ''
            if (chunk.type === 'finish' && ['error', 'aborted'].includes(chunk.reason.kind)) throw new Error(chunk.reason.failure.message)
          }
          return { stopReason: 'completed', output: [{ type: 'text', text: output }] }
        })()
        return { id: `${experimentCell.mode}-${phase}`, result, async dispose() {} }
      } })
    await ctx.plugin(Engine, { provider: 'offline', maxConcurrentAgents: 1 })
    const session = ctx.sessions.create(undefined, { meta: { cwd: process.cwd() } })
    const parent = { id: session.id, ctx, session, options: {}, status: 'idle' }; ctx.agents.register(parent)
    return { ctx, parent, subagentProvider: 'offline', async dispose() { await ctx.fiber.dispose() } }
  } catch (error) { await ctx.fiber.dispose(); throw error }
}
