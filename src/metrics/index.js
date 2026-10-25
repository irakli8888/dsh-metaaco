import { randomUUID } from 'node:crypto'
import { canonicalJson, fields, jsonObject, text } from '../contracts/bank.js'
import { validateBilling } from '../bank/accounting.js'
import { calculateCost, normalizeUsage, tokenFields, nonnegative } from './pricing.js'
export { calculateCost, normalizeUsage } from './pricing.js'

const processClockId = randomUUID()
const categories = ['analysis', 'planning', 'queue', 'agent', 'test', 'workflow']
const statuses = ['completed', 'failed', 'cancelled', 'timeout', 'interrupted']
const clone = value => JSON.parse(canonicalJson(value))
function sum(values) {
  const total = values.reduce((n, v) => n + BigInt(v), 0n)
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Metrics total exceeds safe integer range')
  return Number(total)
}
function union(intervals) {
  let total = 0, end = -Infinity
  for (const [start, finish] of intervals.toSorted((a, b) => a[0] - b[0])) {
    total += Math.max(0, finish - Math.max(start, end)); end = Math.max(end, finish)
  }
  return total
}

/** Durable event projection; observations never change the quality decision. */
export class MetricsCollector {
  #bank
  #attemptId
  #clock
  #clockId

  constructor({ bank, attemptId, estimates, clock = { now: () => performance.now(), utc: () => new Date().toISOString() }, clockId = processClockId }) {
    const prior = bank.getEvents(attemptId).find(e => e.eventId === 'metrics/session')
    estimates ??= prior?.payload.data.estimates ?? {}
    text(attemptId, 'attemptId'); text(clockId, 'clockId'); jsonObject(estimates, 'estimates')
    if (!bank.getAttempt(attemptId)) throw new Error('Unknown metrics attempt')
    if (typeof clock.now !== 'function' || typeof clock.utc !== 'function') throw new Error('A monotonic clock and UTC clock are required')
    this.#bank = bank; this.#attemptId = attemptId; this.#clock = clock; this.#clockId = clockId
    this.#append('session', { type: 'session', estimates: clone(estimates) })
  }

  #events() { return this.#bank.getEvents(this.#attemptId).filter(e => e.kind === 'metrics-v1') }

  #append(id, data) {
    const events = this.#events(), eventId = `metrics/${id}`
    const existing = events.find(e => e.eventId === eventId)
    if (existing) {
      if (canonicalJson(existing.payload.data) !== canonicalJson(data)) throw new Error('Metrics event id conflict')
      return existing.payload
    }
    if (events.some(e => e.payload.data.type === 'finish')) throw new Error('Metrics collection is finished')
    const monotonicMs = this.#clock.now(), recordedAt = this.#clock.utc()
    if (!Number.isFinite(monotonicMs) || monotonicMs < 0 || !Number.isFinite(Date.parse(recordedAt))) throw new Error('Invalid metrics clock')
    if (events.some(e => e.payload.clockId === this.#clockId && e.payload.monotonicMs > monotonicMs)) throw new Error('Monotonic clock went backwards')
    return this.#bank.appendMetricsEvent(this.#attemptId, eventId, {
      schemaVersion: 1, clockId: this.#clockId, monotonicMs, recordedAt, data,
    }).payload
  }

  startSpan(spanId, category, source = 'caller-monotonic') {
    text(spanId, 'spanId'); text(source, 'span source')
    if (!categories.includes(category)) throw new Error('Unknown span category')
    return this.#append(`span-start/${spanId}`, { type: 'span-start', spanId, category, source })
  }

  endSpan(spanId, status, source = 'caller-monotonic') {
    text(spanId, 'spanId'); text(source, 'span source')
    if (!statuses.includes(status)) throw new Error('Unknown span status')
    if (!this.#events().some(e => e.payload.data.type === 'span-start' && e.payload.data.spanId === spanId)) throw new Error('Unknown span')
    return this.#append(`span-end/${spanId}`, { type: 'span-end', spanId, status, source })
  }

  recordCall(input) {
    fields(input, ['callId', 'provider', 'model', 'modelRevision', 'requestId', 'status', 'kind', 'latencyMs', 'usage', 'pricing', 'billing', 'source'], 'ModelCallRecord')
    for (const key of ['callId', 'kind', 'source']) text(input[key], key)
    for (const key of ['provider', 'model', 'modelRevision', 'requestId']) if (input[key] !== null) text(input[key], key)
    if (!statuses.includes(input.status)) throw new Error('Unknown call status')
    if (input.latencyMs !== null && (!Number.isFinite(input.latencyMs) || input.latencyMs < 0)) throw new Error('Invalid call latency')
    if (input.billing !== null) validateBilling(input.billing)
    const usage = normalizeUsage(input.usage)
    const calculatedCost = calculateCost(usage, input.pricing)
    if (input.pricing && ['provider', 'model', 'modelRevision'].some(key => input[key] !== input.pricing[key])) {
      throw new Error('Pricing snapshot does not match pinned model route')
    }
    return this.#append(`call/${input.callId}`, { type: 'call', record: clone({ ...input, usage, calculatedCost }) })
  }

  finish(status, { coverageComplete = false } = {}) {
    if (!statuses.includes(status) || typeof coverageComplete !== 'boolean') throw new Error('Invalid metrics finish')
    return this.#append('finish', { type: 'finish', status, coverageComplete })
  }

  recordBilling(correctionId, callId, billing) {
    if (!this.#events().some(e => e.payload.data.type === 'call' && e.payload.data.record.callId === callId)) throw new Error('Unknown billed call')
    return this.#bank.recordAccountingCorrection(this.#attemptId, correctionId, { callId, billing })
  }

  snapshot() {
    const accounting = this.#bank.getAccountingSnapshot(this.#attemptId)
    const records = accounting.events.filter(e => e.kind === 'metrics-v1').map(e => e.payload)
    const start = records.find(e => e.data.type === 'session'), finish = records.find(e => e.data.type === 'finish')
    const unavailable = [], coverageComplete = finish?.data.coverageComplete === true
    const duration = (a, b, label) => {
      if (!b) { unavailable.push(`${label}: end not observed`); return null }
      if (a.clockId !== b.clockId || b.monotonicMs < a.monotonicMs) {
        unavailable.push(`${label}: incompatible monotonic clock epochs`); return null
      }
      return b.monotonicMs - a.monotonicMs
    }
    const wallTimeMs = duration(start, finish, 'wallTimeMs')
    const spans = {}
    for (const category of categories) {
      const starts = records.filter(e => e.data.type === 'span-start' && e.data.category === category)
      if (!starts.length) continue
      const intervals = [], durations = []
      for (const a of starts) {
        const b = records.find(e => e.data.type === 'span-end' && e.data.spanId === a.data.spanId)
        const elapsed = duration(a, b, `span ${a.data.spanId}`)
        if (elapsed !== null) { intervals.push([a.monotonicMs, b.monotonicMs]); durations.push(elapsed) }
      }
      const compatible = new Set(starts.map(s => s.clockId)).size === 1
      const complete = durations.length === starts.length
      if (!compatible) unavailable.push(`${category}: union crosses clock epochs`)
      spans[category] = { count: starts.length, sumMs: complete ? durations.reduce((a, b) => a + b, 0) : null,
        unionMs: complete && compatible ? union(intervals) : null, knownSumMs: durations.reduce((a, b) => a + b, 0) }
    }
    const calls = records.filter(e => e.data.type === 'call').map(e => e.data.record)
    if (!coverageComplete) unavailable.push('Call coverage is incomplete; unobserved calls may exist')
    const usage = {}, knownUsage = {}
    for (const key of tokenFields) {
      knownUsage[key] = sum(calls.map(c => c.usage[key]).filter(v => v !== null))
      usage[key] = coverageComplete && calls.every(c => c.usage[key] !== null) ? knownUsage[key] : null
      if (usage[key] === null) unavailable.push(`${key}: usage or coverage unavailable`)
    }
    for (const c of calls) {
      for (const key of ['provider', 'model', 'modelRevision', 'requestId', 'latencyMs']) {
        if (c[key] === null) unavailable.push(`${c.callId}: ${key} not reported`)
      }
      if (c.calculatedCost.reason) unavailable.push(`${c.callId}: ${c.calculatedCost.reason}`)
    }
    const currencies = [...new Set(calls.map(c => c.calculatedCost.currency).filter(Boolean))].sort()
    const allCostsKnown = coverageComplete && calls.every(c => c.calculatedCost.microunits !== null)
    const costs = currencies.map(currency => {
      const values = calls.filter(c => c.calculatedCost.currency === currency)
      const knownMicrounits = sum(values.map(c => c.calculatedCost.microunits).filter(v => v !== null))
      return { currency, knownMicrounits, microunits: allCostsKnown ? knownMicrounits : null }
    })
    const billing = new Map(calls.filter(c => c.billing !== null).map(c => [c.callId, { callId: c.callId, ...c.billing }]))
    const corrections = accounting.corrections
    for (const c of corrections) billing.set(c.callId, { callId: c.callId, ...c.billing, correctionId: c.correctionId })
    const testReports = accounting.events.filter(e => e.kind === 'evaluation-report').map(e => {
      const report = JSON.parse(this.#bank.getArtifact(e.payload.artifact))
      return { phase: e.payload.phase, suiteId: report.suiteId, durationMs: report.durationMs,
        status: report.status, testSuiteHash: report.testSuiteHash, snapshotHash: report.snapshotHash }
    })
    const runnerMsSum = testReports.reduce((n, r) => {
      if (!Number.isFinite(r.durationMs) || r.durationMs < 0) throw new Error('Invalid test duration evidence')
      return n + r.durationMs
    }, 0)
    return { schemaVersion: 1, measured: { wallTimeMs, spans, observedCallCount: calls.length, usage, knownUsage, coverageComplete,
      testing: { observedRuns: testReports.length, runnerMsSum, reports: testReports } },
      calculated: { costs, pricingComplete: allCostsKnown, unpricedCallCount: calls.filter(c => c.calculatedCost.microunits === null).length },
      providerReportedBilling: [...billing.values()].sort((a, b) => a.callId.localeCompare(b.callId)),
      estimates: clone(start.data.estimates), calls: clone(calls), accountingRevision: corrections.length,
      unavailable, provenance: { source: 'metrics-collector-v1', attemptId: this.#attemptId,
        eventSequence: accounting.events.at(-1)?.sequence ?? 0,
        startedAt: start.recordedAt, finishedAt: finish?.recordedAt ?? null } }
  }
}

/** Shared SQLite admission, not an automatic interceptor of Harness model requests. */
export class BudgetController {
  #bank
  #budgetId
  constructor({ bank, budgetId, currency, limitMicrounits }) {
    bank.createBudget({ budgetId, currency, limitMicrounits }); this.#bank = bank; this.#budgetId = budgetId
  }
  reserve(input) { return this.#bank.reserveBudget({ ...input, budgetId: this.#budgetId }) }
  settle(input) { return this.#bank.settleBudget({ ...input, budgetId: this.#budgetId }) }
  snapshot() { return this.#bank.getBudget(this.#budgetId) }

  async run({ reservationId, attemptId, upperBoundMicrounits, allowLlm = false }, operation, costOf) {
    if (allowLlm !== true) throw new Error('Explicit allowLlm: true is required before dispatch')
    if (typeof operation !== 'function' || typeof costOf !== 'function') throw new Error('Operation and cost resolver are required')
    nonnegative(upperBoundMicrounits, 'Trusted cost upper bound')
    const reserved = this.reserve({ reservationId, attemptId, upperBoundMicrounits })
    if (!reserved.created) throw new Error('Reservation already dispatched or pending; automatic replay is prohibited')
    let result, actualMicrounits
    try {
      result = await operation()
      actualMicrounits = costOf(result)
      if (actualMicrounits !== null) nonnegative(actualMicrounits, 'actual cost')
    } catch (error) {
      this.settle({ reservationId, settlementId: `unknown/${reservationId}`, actualMicrounits: null,
        source: 'operation or cost reconciliation failed; billing unknown' })
      throw error
    }
    const reconciled = this.settle({ reservationId, settlementId: `dispatch/${reservationId}`, actualMicrounits, source: 'operation cost resolver' })
    if (reconciled.violated) throw new Error('Budget or trusted cost upper bound was exceeded; further dispatch blocked')
    return result
  }
}
