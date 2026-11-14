import { randomUUID } from 'node:crypto'
import { calculateCost, normalizeUsage, nonnegative, validatePrice } from '../../metrics/pricing.js'

/** Deployment adapter boundary. The wrapped adapter must not hide retries or unbounded extra charges. */
export function createBudgetedAdapter(adapter, { collector, budget, attemptId, quote, models, tools = [], allowLlm = false, signal }) {
  if (typeof adapter?.stream !== 'function' || typeof quote !== 'function') throw new Error('Adapter and trusted quote resolver required')
  if (collector.snapshot().provenance.attemptId !== attemptId) throw new Error('Collector attempt mismatch')
  const allowedModels = new Set(models), allowedTools = new Set(tools)
  const check = options => {
    if (allowLlm !== true) throw new Error('Explicit allowLlm: true is required')
    signal?.throwIfAborted(); options.signal?.throwIfAborted()
    if (!allowedModels.has(`${options.provider}/${options.model}`)) throw new Error('Model route is not allowed')
    if ((options.tools ?? []).some(t => !allowedTools.has(t.name))) throw new Error('Tool is not allowed')
  }
  async function* stream(options, dispatch) {
    check(options)
    const combined = signal && options.signal ? AbortSignal.any([signal, options.signal]) : signal ?? options.signal
    const request = { ...structuredClone({ ...options, signal: undefined }), signal: combined }
    const quoted = quote(structuredClone({ ...request, signal: undefined }))
    const pricing = structuredClone(quoted.pricing), upperBoundMicrounits = quoted.upperBoundMicrounits
    nonnegative(upperBoundMicrounits, 'Trusted upper bound'); validatePrice(pricing)
    if (pricing.provider !== request.provider || pricing.model !== request.model) throw new Error('Pricing route mismatch')
    if (budget && pricing.currency !== budget.snapshot().currency) throw new Error('Budget currency mismatch')
    check(request)
    const callId = `adapter/${randomUUID()}`
    if (budget) budget.reserve({ reservationId: callId, attemptId, upperBoundMicrounits })
    const start = performance.now()
    let usage = null, finished = false, exhausted = false, failed = false, aborted = false
    try {
      for await (const chunk of dispatch(request)) {
        combined?.throwIfAborted()
        if (chunk.type === 'usage') usage = normalizeUsage(chunk.usage)
        if (chunk.type === 'finish') {
          finished = ['stop', 'tool-calls', 'max-tokens'].includes(chunk.reason?.kind)
          aborted = chunk.reason?.kind === 'aborted'
          failed ||= !finished
        }
        yield chunk
      }
      combined?.throwIfAborted(); exhausted = true
    } catch (error) { failed = true; throw error }
    finally {
      const complete = exhausted && finished && !failed
      // Partial usage is evidence, never proof of a complete bill.
      const actual = complete ? calculateCost(usage, pricing).microunits : null
      let settlement
      try {
        collector.recordCall({ callId, provider: request.provider, model: request.model, modelRevision: pricing.modelRevision,
          requestId: null, status: combined?.aborted || aborted ? 'cancelled' : failed ? 'failed' : complete ? 'completed' : 'interrupted',
          kind: request.purpose ?? 'model', latencyMs: performance.now() - start, usage, pricing, billing: null,
          source: 'guarded-adapter-stream-v1' })
      } finally {
        if (budget) settlement = budget.settle({ reservationId: callId, settlementId: callId,
          actualMicrounits: actual, source: complete ? 'complete adapter usage and pinned tariff' : 'incomplete stream; reservation retained' })
      }
      if (settlement?.violated) throw new Error('Trusted upper bound or budget exceeded; further dispatch blocked')
    }
  }
  return new Proxy(adapter, { get(target, property) {
    if (property === 'stream') return options => stream(options, request => target.stream(request))
    if (property === 'prepareCall') return async (provider, model, preparationSignal) => {
      check({ provider, model, signal: preparationSignal })
      const prepared = await target.prepareCall(provider, model, preparationSignal)
      let used = false
      return { model: prepared.model, stream(options) {
        if (used) throw new Error('Prepared call already dispatched')
        used = true
        if (options.provider !== provider || options.model !== model) throw new Error('Prepared route changed')
        return stream(options, request => prepared.stream(request))
      } }
    }
    const value = Reflect.get(target, property, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
}
