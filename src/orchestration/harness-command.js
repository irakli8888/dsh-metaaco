import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

export function registerSkillCommand(ctx, path) {
  ctx.commands.register({
    name: 'metaaco-skills',
    description: 'Preview or execute a configured MetaACO skill job',
    input: { hint: '[--allow-llm]' },
    async handler({ rawInput, agent, signal }) {
      const mode = rawInput.trim()
      if (mode !== '' && mode !== '--allow-llm') {
        return { kind: 'error', text: 'Usage: /metaaco-skills [--allow-llm]' }
      }
      try {
        const job = JSON.parse(await readFile(path, 'utf8'))
        if (job.schemaVersion !== 1 || !Number.isSafeInteger(job.budgetMicrounits) || job.budgetMicrounits <= 0) {
          throw new Error('Expected skill job v1 with a positive budget')
        }
        if (!mode) return { kind: 'success', text: JSON.stringify({ preview: true,
          taskId: job.request.taskId, budgetMicrounits: job.budgetMicrounits, slots: job.resources.agentSlots,
          skills: Object.fromEntries(Object.entries(job.skills).map(([id, routes]) => [id, routes.map(route => route.model)])),
          run: '/metaaco-skills --allow-llm' }, null, 2) }
        signal?.throwIfAborted()
        const runtimeContext = agent?.ctx ?? ctx
        if (!agent || !runtimeContext.subagents || !isAbsolute(job.bankDir ?? '') ||
            !/^sha256:[a-f0-9]{64}$/.test(job.evaluationDockerImage ?? '')) {
          throw new Error('Execution requires a Harness agent, subagents, an absolute Bank directory and a pinned Docker image')
        }
        const key = process.env.DEEPSEEK_API_KEY
        const [{ StrategyBank }, { readFeedback }, { runSkillAttempt }, { createDeepSeekAdapter }] = await Promise.all([
          import('../bank/index.js'), import('../feedback/index.js'), import('./skill-attempt.js'),
          import('../adapters/harness/deepseek.js'),
        ])
        const { adapter, quote } = createDeepSeekAdapter({ key })
        const bank = new StrategyBank({ dataDir: job.bankDir })
        try {
          const { revision } = readFeedback(bank, job.feedback)
          if (revision.policy.maxCostMicrounits === null || revision.policy.maxCostMicrounits > job.budgetMicrounits) {
            throw new Error('Feedback policy must enforce a per-attempt cap within the job budget')
          }
          const result = await runSkillAttempt({
            bank, feedback: job.feedback, candidate: job.candidate, request: job.request,
            baseSnapshot: job.baseSnapshot, skills: job.skills, resources: job.resources,
            requiredSkills: job.requiredSkills, budgetMicrounits: job.budgetMicrounits,
            evaluationDockerImage: job.evaluationDockerImage, attemptId: randomUUID(),
            signal, allowLlm: true, guardedCallsOnly: true,
            createRuntime: async ({ guardAdapter, signal: attemptSignal }) => {
              const guarded = guardAdapter(adapter, quote)
              const name = `metaaco-${randomUUID()}`
              const dispose = runtimeContext.subagents.registerProvider({ name, inheritsParentContext: false,
                capabilities: { agentOptions: true, agentPreset: false, outputSchema: false, depthLimit: false },
                async start(request) {
                  const { provider, model } = request.agentOptions
                  const controller = new AbortController()
                  const signals = [controller.signal, request.signal, attemptSignal].filter(Boolean)
                  const result = (async () => {
                    let text = ''
                    for await (const chunk of guarded.stream({ provider, model, messages: [],
                      system: 'Return only a JSON object with revision (a unique nonempty string) and files (full contents by relative path). Do not include control tests.\n'
                        + request.prompt[0].text, signal: AbortSignal.any(signals) })) {
                      if (chunk.type === 'block-end') text += chunk.block.text ?? ''
                      if (chunk.type === 'finish' && chunk.reason.kind !== 'stop') throw new Error(chunk.reason.kind)
                    }
                    return { stopReason: 'completed', output: [{ type: 'text', text }] }
                  })()
                  return { id: randomUUID(), result, async dispose() { controller.abort(); await result.catch(() => {}) } }
                },
              })
              return { ctx: runtimeContext, parent: agent, subagentProvider: name, dispose }
            },
          })
          return { kind: result.attempt.state === 'succeeded' ? 'success' : 'error',
            text: JSON.stringify({ attemptId: result.attempt.attemptId, state: result.attempt.state,
              choices: result.skillSelection.choices, costs: result.attempt.outcome?.calculated?.costs, feedback: result.feedback }, null, 2) }
        } finally { bank.close() }
      } catch (error) { return { kind: 'error', text: error.message } }
    },
  })
}
