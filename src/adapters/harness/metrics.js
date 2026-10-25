import { randomUUID } from 'node:crypto'
import { runWorkflow } from '../../../index.js'
import { normalizeUsage } from '../../metrics/pricing.js'
import { fields, text } from '../../contracts/bank.js'

/** Verified against installed Harness 0.2.1-rc.2 durable assistant event types. */
export function harnessCallRecord(sessionId, event, route = null) {
  if (!['assistant/message', 'assistant/attempt'].includes(event.type)) return null
  text(sessionId, 'sessionId')
  if (route !== null) fields(route, ['provider', 'model', 'modelRevision', 'pricing'], 'Pinned route')
  if (!Number.isSafeInteger(event.seq) || event.seq < 0) throw new Error('Invalid session sequence')
  const data = event.data
  let lastUsage = null, lastFinish = null
  for (const record of data.stream ?? []) {
    if (record.type === 'chunk' && record.chunk?.type === 'usage') lastUsage = record.chunk.usage
    if (record.type === 'chunk' && record.chunk?.type === 'finish') lastFinish = record.chunk.reason
  }
  const usage = normalizeUsage(data.usage ?? lastUsage)
  const status = data.interrupted || lastFinish?.kind === 'aborted' ? 'cancelled'
    : event.type === 'assistant/attempt' || lastFinish?.kind === 'error' ? 'failed' : 'completed'
  return { callId: `harness/${sessionId}/${event.seq}`, provider: route?.provider ?? null,
    model: route?.model ?? null, modelRevision: route?.modelRevision ?? null, requestId: null,
    status, kind: event.type === 'assistant/attempt' ? 'attempt' : 'agent', latencyMs: null,
    usage, pricing: route?.pricing ?? null, billing: null, source: `harness-0.2.1-rc.2/${event.type}` }
}

/** Observe one real run; this is accounting, not per-request budget enforcement. */
export async function runMeasuredWorkflow(ctx, parent, input, { collector, allowLlm = false, routeForEvent = () => null, ...options } = {}) {
  if (allowLlm !== true) throw new Error('Explicit allowLlm: true is required before workflow execution')
  if (!collector || typeof routeForEvent !== 'function') throw new Error('Collector and synchronous route resolver are required')
  const spanId = `workflow/${randomUUID()}`, children = new Set(), pending = new Map(), progress = []
  const errors = [], disposers = []
  let runId = null, status = 'failed', buffered = 0, spanStarted = false
  const safely = fn => (...args) => { try { fn(...args) } catch (error) { errors.push(error) } }
  const onAgent = (kind, run, info) => {
    if (!runId) { progress.push([kind, run, info]); return }
    if (run.id !== runId) return
    const agentSpan = `${spanId}/agent/${info.seq}`
    if (kind === 'start') {
      children.add(info.childId)
      collector.startSpan(agentSpan, 'agent', 'harness-observer-receipt')
      for (const record of pending.get(info.childId) ?? []) collector.recordCall(record)
      buffered -= pending.get(info.childId)?.length ?? 0
      pending.delete(info.childId)
    } else collector.endSpan(agentSpan, info.outcome === 'completed' ? 'completed' : 'failed', 'harness-observer-receipt')
  }
  try {
    collector.startSpan(spanId, 'workflow', 'runWorkflow-monotonic-wrapper')
    spanStarted = true
    disposers.push(ctx.on('workflow/agent-start', safely((run, info) => onAgent('start', run, info))))
    disposers.push(ctx.on('workflow/agent-end', safely((run, info) => onAgent('end', run, info))))
    disposers.push(ctx.on('session/event', safely((session, event) => {
      if (!['assistant/message', 'assistant/attempt'].includes(event.type)) return
      const record = harnessCallRecord(session.id, event, routeForEvent(session, event))
      if (children.has(session.id)) collector.recordCall(record)
      else {
        if (buffered >= 10000) throw new Error('Metrics pending-session buffer exceeded')
        if (!pending.has(session.id)) pending.set(session.id, [])
        pending.get(session.id).push(record); buffered++
      }
    })))
    const measuredCtx = { workflowEngine: { start(request) {
      const run = ctx.workflowEngine.start(request)
      runId = run.id
      for (const args of progress.splice(0)) onAgent(...args)
      return run
    } } }
    const result = await runWorkflow(measuredCtx, parent, input, options)
    status = 'completed'
    if (errors.length) throw new AggregateError(errors, 'Harness metrics observation failed')
    return result
  } finally {
    if (options.signal?.aborted) status = 'cancelled'
    for (const dispose of disposers) dispose()
    if (spanStarted) collector.endSpan(spanId, status, 'runWorkflow-monotonic-wrapper')
    // Coverage remains partial: abandoned calls, nested agents and compaction may not publish here.
  }
}
