import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export const name = 'metaaco'
export const inject = ['workflowEngine', 'commands']

// This body is owned by the plugin. JSON supplies data, never executable code.
export const SCRIPT = `
const results = {};
for (const stage of args.stages) {
  phase(stage.title);
  const values = await parallel(stage.agents.map(task => async () => {
    const value = await agent(task.prompt, { label: task.id });
    return { id: task.id, value };
  }));
  if (values.some(item => item === null || item.value === null)) {
    throw new Error('A child failed; dependent stages were not started');
  }
  for (const item of values) results[item.id] = item.value;
}
return results;
`

/** Parse the deliberately small JSON scheduling language. */
export function validateWorkflow(value) {
  const object = (v, keys) => v !== null && typeof v === 'object' && !Array.isArray(v)
    && Object.keys(v).every(key => keys.includes(key))
  const text = v => typeof v === 'string' && v.trim().length > 0
  if (!object(value, ['name', 'description', 'stages'])
    || !text(value.name) || !/^[a-z][a-z0-9-]*$/.test(value.name)
    || !text(value.description) || !Array.isArray(value.stages) || !value.stages.length) {
    throw new Error('Workflow requires name (kebab-case), description and nonempty stages')
  }
  const ids = new Set(), titles = new Set()
  let count = 0
  for (const stage of value.stages) {
    if (!object(stage, ['title', 'agents']) || !text(stage.title) || titles.has(stage.title)
      || !Array.isArray(stage.agents) || !stage.agents.length) {
      throw new Error('Each stage requires a unique title and nonempty agents')
    }
    titles.add(stage.title)
    for (const task of stage.agents) {
      if (!object(task, ['id', 'prompt']) || !text(task.id) || !/^[a-z][a-z0-9-]*$/.test(task.id)
        || ids.has(task.id) || !text(task.prompt)) {
        throw new Error('Each child requires a unique kebab-case id and prompt')
      }
      ids.add(task.id)
      count++
    }
  }
  return { workflow: value, count }
}

/** Start directly on the engine; no parent model turn or model-authored script. */
export async function runWorkflow(ctx, parent, input, { signal, subagentProvider = 'spawn' } = {}) {
  const { workflow, count } = validateWorkflow(input)
  if (!parent) throw new Error('A live parent Agent is required')
  signal?.throwIfAborted()
  const run = ctx.workflowEngine.start({
    script: SCRIPT,
    meta: {
      name: workflow.name,
      description: workflow.description,
      phases: workflow.stages.map(stage => ({ title: stage.title })),
    },
    args: { stages: workflow.stages },
    parent,
    subagentProvider,
    maxTotalAgents: count,
    ...(signal ? { signal } : {}),
  })
  const cancel = () => run.cancel('metaaco caller aborted')
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    if (signal?.aborted) cancel()
    const result = await run.result
    if (result.stopReason !== 'completed') {
      throw new Error(`Workflow ${result.stopReason}: ${result.error ?? 'no details'}`)
    }
    return { runId: run.id, agentsStarted: result.agentsStarted, result: result.value }
  } finally {
    signal?.removeEventListener('abort', cancel)
    await run.dispose()
  }
}

/** Register a human command. A bare command previews; --allow-llm explicitly starts children. */
export function apply(ctx, config = {}) {
  if (typeof config.workflowFile !== 'string' || !config.workflowFile.trim()) {
    throw new Error('metaaco config.workflowFile is required')
  }
  if (config.subagentProvider !== undefined && (typeof config.subagentProvider !== 'string' || !config.subagentProvider.trim())) {
    throw new Error('metaaco config.subagentProvider must be a nonempty string')
  }
  const path = resolve(config.workflowFile)
  ctx.commands.register({
    name: 'metaaco',
    description: 'Preview fixed JSON workflow; --allow-llm explicitly permits child model calls',
    input: { hint: '[--allow-llm]' },
    async handler({ agent, rawInput, signal }) {
      const mode = rawInput.trim()
      if (mode !== '' && mode !== '--allow-llm') return { kind: 'error', text: 'Usage: /metaaco [--allow-llm]' }
      const { workflow, count } = validateWorkflow(JSON.parse(await readFile(path, 'utf8')))
      if (!mode) {
        return { kind: 'success', text: JSON.stringify({
          preview: true, name: workflow.name, children: count,
          stages: workflow.stages.map(stage => ({ title: stage.title, agents: stage.agents.map(task => task.id) })),
          run: '/metaaco --allow-llm',
        }, null, 2) }
      }
      const result = await runWorkflow(ctx, agent, workflow, { signal, subagentProvider: config.subagentProvider })
      return { kind: 'success', text: JSON.stringify(result, null, 2) }
    },
  })
}
