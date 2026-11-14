import { randomUUID, createHash } from 'node:crypto'
import { canonicalJson, text } from '../contracts/bank.js'
import { validateDag } from './contracts.js'
export { validateDag } from './contracts.js'

// Only plugin-owned code executes. Prompts, artifacts and routing stay in args.
export const DAG_NODE_SCRIPT = `
const options = { label: args.taskId };
if (args.model !== null) {
  options.provider = args.model.provider;
  options.model = args.model.model;
}
return await agent(args.prompt, options);
`

export function previewDag(input) {
  const plan = validateDag(input)
  return { preview: true, version: 3, name: plan.name, resources: plan.resources,
    tasks: plan.tasks.map(({ prompt, ...task }) => task) }
}

export class DagExecutionError extends Error {
  constructor(report, cause) {
    super(`DAG execution ${report.status}`, cause ? { cause } : undefined)
    this.name = 'DagExecutionError'; this.report = report
  }
}

async function runNode(ctx, parent, plan, task, prompt, signal, subagentProvider, onStart) {
  signal.throwIfAborted()
  const run = ctx.workflowEngine.start({ script: DAG_NODE_SCRIPT,
    meta: { name: plan.name, description: plan.description, phases: [] },
    args: { taskId: task.id, slots: task.slots, model: task.model, prompt },
    parent, subagentProvider, maxTotalAgents: 1, signal })
  let rejectAbort
  const aborted = new Promise((_, reject) => { rejectAbort = reject })
  const cancel = () => {
    try { run.cancel('DAG aborted') } catch (error) { rejectAbort(error) }
    finally { rejectAbort(signal.reason) }
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    onStart(run.id)
    if (signal.aborted) cancel()
    const result = await Promise.race([run.result, aborted])
    signal.throwIfAborted()
    if (result.stopReason !== 'completed') throw new Error(`Harness ${result.stopReason}: ${result.error ?? 'no details'}`)
    if (typeof result.value !== 'string') throw new Error('Child did not return a completed text artifact')
    return { runId: run.id, output: result.value }
  } finally {
    signal.removeEventListener('abort', cancel)
    await run.dispose()
  }
}

/** One DAG per existing Bank attempt. A completed execution is NOT verified quality. */
export async function runDag(ctx, parent, input, { bank, attemptId, allowLlm = false, signal,
  subagentProvider = 'spawn', verifyArtifact = async () => {} } = {}) {
  const plan = validateDag(input)
  if (allowLlm !== true) throw new Error('Explicit allowLlm: true is required for execution')
  if (!parent) throw new Error('A live parent Agent is required')
  text(attemptId, 'attemptId'); text(subagentProvider, 'subagentProvider')
  signal?.throwIfAborted()
  if (typeof verifyArtifact !== 'function') throw new Error('verifyArtifact must be a trusted callback')
  if (!bank || bank.getAttempt(attemptId)?.state !== 'running') throw new Error('A running Bank attempt is required')
  if (bank.getEvents(attemptId).some(e => e.eventId === 'dag/start')) throw new Error('DAG already started; automatic replay is forbidden')
  const executionId = randomUUID(), started = performance.now(), controller = new AbortController()
  const planArtifact = bank.putArtifact(Buffer.from(canonicalJson(plan)))
  // Random executionId makes a concurrent duplicate writer conflict, not idempotently dispatch again.
  bank.appendEvent(attemptId, 'dag/start', { kind: 'dag-start-v1', payload: { executionId, planArtifact } })
  bank.attachArtifact(attemptId, 'dag-plan', planArtifact)
  const nodes = new Map(plan.tasks.map(t => [t.id, { id: t.id, state: 'pending', artifact: null,
    inputs: [], runId: null, wallTimeMs: null, reason: null }]))
  const active = new Map()
  let usedSlots = 0, timedOut = false, fatal = null
  const abort = () => controller.abort(signal.reason)
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  const timer = setTimeout(() => { timedOut = true; controller.abort(new Error('DAG deadline exceeded')) }, plan.resources.timeoutMs)
  const record = node => bank.appendEvent(attemptId, `dag/task/${node.id}/${node.state}`,
    { kind: 'dag-task-v1', payload: JSON.parse(canonicalJson(node)) })
  const execute = async task => {
    const node = nodes.get(task.id), start = performance.now()
    node.state = 'running'
    try {
      record(node)
      let inputBytes = 0
      const artifacts = task.inputs.map(binding => {
        const ref = nodes.get(binding.taskId).artifact
        if (!ref) throw new Error('Missing dependency artifact')
        inputBytes += ref.sizeBytes
        if (inputBytes > plan.resources.maxInputBytes) throw new Error('Input artifacts exceed maxInputBytes')
        const content = bank.getArtifact(ref).toString('utf8')
        node.inputs.push({ name: binding.name, producer: binding.taskId, ...ref })
        return { name: binding.name, producer: binding.taskId, sha256: ref.sha256, content }
      })
      const prompt = canonicalJson({ schemaVersion: 1, task: task.prompt, artifacts })
      if (Buffer.byteLength(prompt) > plan.resources.maxInputBytes) throw new Error('Input envelope exceeds maxInputBytes')
      const result = await runNode(ctx, parent, plan, task, prompt, controller.signal, subagentProvider,
        runId => { node.runId = runId })
      node.runId = result.runId
      controller.signal.throwIfAborted()
      const bytes = Buffer.from(result.output)
      if (bytes.length > plan.resources.maxArtifactBytes) throw new Error('Output artifact exceeds maxArtifactBytes')
      node.artifact = bank.putArtifact(bytes)
      bank.attachArtifact(attemptId, `dag-output/${task.id}`, node.artifact)
      await verifyArtifact({ taskId: task.id, artifact: { ...node.artifact }, signal: controller.signal })
      controller.signal.throwIfAborted()
      node.state = 'completed'
    } catch (error) {
      node.state = controller.signal.aborted ? (timedOut ? 'timeout' : 'cancelled') : 'failed'
      node.reason = error instanceof Error ? error.message : String(error)
    }
    node.wallTimeMs = performance.now() - start
    record(node)
  }
  try {
    while (true) {
      for (const task of plan.tasks) {
        const node = nodes.get(task.id)
        if (node.state !== 'pending') continue
        if (controller.signal.aborted) {
          node.state = timedOut ? 'timeout' : 'cancelled'; node.reason = 'DAG aborted before dispatch'; record(node)
          continue
        }
        const deps = task.dependsOn.map(id => nodes.get(id).state)
        if (deps.some(s => ['failed', 'blocked', 'cancelled', 'timeout'].includes(s))) {
          node.state = 'blocked'; node.reason = 'Dependency did not complete'; record(node)
          continue
        }
        if (!deps.every(s => s === 'completed') || usedSlots + task.slots > plan.resources.agentSlots) continue
        usedSlots += task.slots
        const promise = execute(task).finally(() => { usedSlots -= task.slots; active.delete(task.id) })
        active.set(task.id, promise)
      }
      if (active.size) await Promise.race(active.values())
      else if ([...nodes.values()].every(n => n.state !== 'pending')) break
      // DAG validation guarantees progress; another scan propagates blocked states in reverse input order.
    }
  } catch (error) {
    fatal = error
    controller.abort(error)
    await Promise.allSettled(active.values())
    for (const node of nodes.values()) if (node.state === 'pending') {
      node.state = 'cancelled'; node.reason = 'Orchestrator failed before dispatch'
    }
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort)
  }
  const status = fatal ? 'failed' : timedOut ? 'timeout' : controller.signal.aborted ? 'cancelled'
    : [...nodes.values()].every(n => n.state === 'completed') ? 'completed' : 'failed'
  const report = { schemaVersion: 1, executionId, planHash: createHash('sha256').update(canonicalJson(plan)).digest('hex'),
    status, quality: 'inconclusive', wallTimeMs: performance.now() - started, tasks: [...nodes.values()] }
  bank.appendEvent(attemptId, 'dag/finish', { kind: 'dag-finish-v1', payload: report })
  if (status !== 'completed') throw new DagExecutionError(report, fatal)
  return report
}
