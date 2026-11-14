import { randomUUID } from 'node:crypto'
import { runDag } from '../../execution/index.js'
import { runMetaacoDag } from '../../planning/index.js'
import { harnessCallRecord } from './metrics.js'

/** One observation scope for all child runs belonging to a DAG, never global accounting. */
async function observeDag(ctx, options, execute) {
  const { collector, allowLlm = false, signal, routeForEvent = () => null } = options
  if (allowLlm !== true) throw new Error('Explicit allowLlm: true is required before DAG observation')
  signal?.throwIfAborted()
  if (!collector || ['startSpan', 'endSpan', 'recordCall', 'snapshot'].some(key => typeof collector[key] !== 'function')
    || typeof routeForEvent !== 'function') throw new Error('Collector and synchronous route resolver are required')
  if (collector.snapshot().provenance.attemptId !== options.attemptId) {
    throw new Error('Collector must belong to the DAG attempt')
  }
  const prefix = `dag/${randomUUID()}`, controller = new AbortController()
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  const runs = new Map(), children = new Map(), pending = new Map(), openSpans = new Set()
  const progress = [], disposers = [], errors = []
  let starting = 0, buffered = 0, spanStarted = false, operationError = null, result
  const fail = error => { if (errors.length < 100) errors.push(error); controller.abort(error) }
  const safely = fn => (...args) => { try { fn(...args) } catch (error) { fail(error) } }
  const record = (session, event, owner) => {
    const route = routeForEvent(session, event, owner)
    collector.recordCall(harnessCallRecord(session.id, event, route))
  }
  const onAgent = (kind, run, info) => {
    if (!runs.has(run.id)) {
      if (starting) {
        if (progress.length >= 10000) throw new Error('DAG progress buffer exceeded')
        progress.push([kind, run, info])
      }
      return
    }
    const span = `${prefix}/${run.id}/agent/${info.seq}`
    if (kind === 'start') {
      if (children.has(info.childId)) return
      const owner = { runId: run.id, taskId: runs.get(run.id) }
      children.set(info.childId, owner)
      collector.startSpan(span, 'agent', 'harness-observer-receipt'); openSpans.add(span)
      for (const [session, event] of pending.get(info.childId) ?? []) record(session, event, owner)
      buffered -= pending.get(info.childId)?.length ?? 0
      pending.delete(info.childId)
    } else if (openSpans.has(span)) {
      collector.endSpan(span, info.outcome === 'completed' ? 'completed' : 'failed', 'harness-observer-receipt')
      openSpans.delete(span)
    }
  }
  try {
    collector.startSpan(prefix, 'workflow', 'dag-observation-wrapper'); spanStarted = true
    disposers.push(ctx.on('workflow/agent-start', safely((run, info) => onAgent('start', run, info))))
    disposers.push(ctx.on('workflow/agent-end', safely((run, info) => onAgent('end', run, info))))
    disposers.push(ctx.on('session/event', safely((session, event) => {
      if (!['assistant/message', 'assistant/attempt'].includes(event.type)) return
      if (children.has(session.id)) record(session, event, children.get(session.id))
      else {
        if (buffered >= 10000) throw new Error('DAG pending-session buffer exceeded')
        if (!pending.has(session.id)) pending.set(session.id, [])
        // Do not resolve routes or validate unrelated sessions. Ownership is established by run ID.
        pending.get(session.id).push([session, event]); buffered++
      }
    })))
    const measuredCtx = { workflowEngine: { start(request) {
      starting++
      let run
      try { run = ctx.workflowEngine.start(request) } finally { starting-- }
      runs.set(run.id, request.args.taskId)
      for (const args of progress.splice(0)) safely(onAgent)(...args)
      return run
    } } }
    result = await execute(measuredCtx, combined)
  } catch (error) { operationError = error }
  finally {
    for (const dispose of disposers) { try { dispose() } catch (error) { errors.push(error) } }
    const state = errors.length ? 'failed' : operationError?.report?.status ?? result?.status
      ?? (combined.aborted ? 'cancelled' : 'failed')
    for (const span of openSpans) {
      try { collector.endSpan(span, combined.aborted ? (state === 'timeout' ? 'timeout' : 'cancelled') : 'interrupted', 'observer-ended-without-agent-end') }
      catch (error) { errors.push(error) }
    }
    if (spanStarted) {
      try { collector.endSpan(prefix, state, 'dag-observation-wrapper') } catch (error) { errors.push(error) }
    }
    pending.clear(); progress.length = 0
  }
  if (errors.length) {
    const failure = new AggregateError([...errors, ...(operationError ? [operationError] : [])], 'DAG metrics observation failed',
      operationError ? { cause: operationError } : undefined)
    failure.report = operationError?.report ?? result ?? null
    throw failure
  }
  if (operationError) throw operationError
  return result
}

export function runMeasuredDag(ctx, parent, plan, options = {}) {
  return observeDag(ctx, options, (measuredCtx, signal) => runDag(measuredCtx, parent, plan, { ...options, signal }))
}

export function runMeasuredMetaacoDag(ctx, parent, result, problem, options = {}) {
  return observeDag(ctx, options, (measuredCtx, signal) => runMetaacoDag(measuredCtx, parent, result, problem, { ...options, signal }))
}
