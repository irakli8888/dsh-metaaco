import { analyzeTask } from '../analyzer/index.js'
import { fields, validateRequest, validateEvaluation, canonicalJson, text } from '../contracts/bank.js'
import { hash, clone, compare, TYPES, STACKS, FEATURE_SCHEMA, utc, validatePolicy, validateCandidate, arm, armId } from './contracts.js'
import { scoreContext } from './linucb.js'

const ALGORITHM = 'disjoint-linucb-v1'
function contextFor(request, at) {
  const analysis = analyzeTask(request, { analyzedAt: at })
  return { type: analysis.classification.type.value, vector: [1,
    ...[...TYPES, null].map(type => Number(analysis.classification.type.value === type)),
    ...STACKS.map(stack => Number(analysis.stack.value?.includes(stack) ?? false)),
    Number(analysis.stack.value === null)] }
}

function verifiedEvaluation(bank, attempt) {
  const e = attempt.evaluation
  if (e?.schemaVersion !== 2 || e.provenance?.source !== 'independent-node-evaluator') return false
  try { validateEvaluation(e) } catch { return false }
  const session = bank.getEvents(attempt.attemptId).find(event => event.eventId === 'evaluation-session')
  return Boolean(session?.kind === 'evaluation-session'
    && session.payload.evaluatorId === e.provenance.evaluatorId
    && session.payload.specHash === hash(attempt.request.testSpec)
    && e.evidence.specHash === session.payload.specHash)
}

/** Explicit train-only input. Terminal attempt records are immutable in Bank. */
export function createSelectorSnapshot(bank, { trainingTaskIds, cutoff } = {}) {
  if (!Array.isArray(trainingTaskIds)) throw new Error('trainingTaskIds must be explicit')
  trainingTaskIds.forEach(id => text(id, 'trainingTaskIds')); utc(cutoff)
  const ids = [...new Set(trainingTaskIds)].sort(compare)
  const records = bank.listAttempts().filter(a => ids.includes(a.request.taskId) && a.state !== 'running'
    && a.finishedAt && Date.parse(a.finishedAt) < Date.parse(cutoff)).map(a => {
    const decision = a.selection.selector
    const { decisionId, ...payload } = decision ?? {}
    const context = contextFor(a.request, cutoff).vector
    const selectionValid = decision?.algorithm === ALGORITHM && decision.featureSchema === FEATURE_SCHEMA
      && decisionId === hash(payload) && decision.requestHash === hash(a.request)
      && canonicalJson(decision.context) === canonicalJson(context)
      && decision.selected !== null && canonicalJson(decision.selected.strategy) === canonicalJson(a.strategy)
      && decision.selected.armId === hash({ strategy: decision.selected.strategy, route: decision.selected.route })
    return { attemptId: a.attemptId, taskId: a.request.taskId, finishedAt: a.finishedAt, state: a.state,
      context, armId: selectionValid ? decision.selected.armId : null,
      evaluationVerified: verifiedEvaluation(bank, a), evaluation: a.evaluation, outcome: a.outcome }
  }).sort((a, b) => compare(a.attemptId, b.attemptId))
  const payload = { schemaVersion: 1, featureSchema: FEATURE_SCHEMA, cutoff, trainingTaskIds: ids, records }
  return clone({ ...payload, snapshotId: hash(payload) })
}

function validateSnapshot(s, selectedAt) {
  fields(s, ['schemaVersion', 'featureSchema', 'cutoff', 'trainingTaskIds', 'records', 'snapshotId'], 'Selector snapshot')
  const { snapshotId, ...payload } = s
  if (s.schemaVersion !== 1 || s.featureSchema !== FEATURE_SCHEMA || snapshotId !== hash(payload)) throw new Error('Invalid selector snapshot')
  if (Date.parse(utc(s.cutoff)) > Date.parse(utc(selectedAt))) throw new Error('Snapshot cutoff is after selection')
  if (!Array.isArray(s.trainingTaskIds) || !Array.isArray(s.records)) throw new Error('Invalid snapshot records')
  const seen = new Set()
  for (const r of s.records) {
    if (seen.has(r.attemptId) || !s.trainingTaskIds.includes(r.taskId) || Date.parse(utc(r.finishedAt)) >= Date.parse(s.cutoff)
      || !Array.isArray(r.context) || r.context.length !== 18 || r.context.some(v => v !== 0 && v !== 1)
      || r.context[0] !== 1 || !['succeeded', 'failed', 'timeout', 'cancelled', 'interrupted', 'inconclusive'].includes(r.state)) {
      throw new Error('Invalid selector snapshot record')
    }
    seen.add(r.attemptId)
  }
}

function exclusions(c, p, type) {
  const reasons = []
  if (c.route.models.some(m => !p.allowedModels.includes(m))) reasons.push('models')
  if (c.route.tools.some(m => !p.allowedTools.includes(m))) reasons.push('tools')
  if (c.route.maxConcurrency > p.maxConcurrency) reasons.push('concurrency')
  if (!c.route.tdd) reasons.push('tdd')
  if (c.taskTypes.length && !c.taskTypes.includes(type)) reasons.push('task-type')
  for (const [limit, value, label, above] of [
    [p.maxWallTimeMs, c.estimates.wallTimeMs, 'time', false],
    [p.maxCostMicrounits, c.estimates.costMicrounits, 'cost', false],
    [p.minQuality, c.estimates.quality, 'quality', true],
  ]) if (limit !== null) {
    if (value === null) reasons.push(`${label}-unavailable`)
    else if (above ? value < limit : value > limit) reasons.push(`${label}-limit`)
  }
  if (p.maxCostMicrounits !== null && c.estimates.currency !== p.currency) reasons.push('currency')
  return reasons
}

function rewardFor(r, p) {
  const missing = reason => ({ reward: null, reason })
  if (['failed', 'timeout', 'cancelled', 'interrupted'].includes(r.state)) return { reward: -1, reason: 'non-success-terminal' }
  if (r.state !== 'succeeded') return missing('inconclusive-outcome')
  const e = r.evaluation
  if (!r.evaluationVerified || e?.status !== 'success' || e.correctness !== 'passed' || e.tddCompliance !== 'passed') return missing('unverified-quality')
  try { validateEvaluation(e) } catch { return missing('invalid-evaluation') }
  const o = r.outcome
  const metrics = o?.schemaVersion === 1 && o.provenance?.source === 'metrics-collector-v1' && o.provenance.attemptId === r.attemptId
  const time = metrics ? o.measured?.wallTimeMs : null
  if (p.weights.time > 0 && (!Number.isFinite(time) || time < 0)) return missing('time-unavailable')
  let cost = null
  if (metrics && o.measured?.coverageComplete === true && o.calculated?.pricingComplete === true) {
    const costs = o.calculated.costs
    if (Array.isArray(costs) && costs.length === 1 && costs[0].currency === p.currency
      && Number.isSafeInteger(costs[0].microunits) && costs[0].microunits >= 0) cost = costs[0].microunits
    else if (Array.isArray(costs) && costs.length === 0 && o.measured.observedCallCount === 0) cost = 0
  }
  if (p.weights.cost > 0 && cost === null) return missing('cost-unavailable')
  return { reward: p.weights.quality
    + (p.weights.time > 0 ? p.weights.time * (1 - Math.min(1, time / p.normalization.wallTimeMs)) : 0)
    + (p.weights.cost > 0 ? p.weights.cost * (1 - Math.min(1, cost / p.normalization.costMicrounits)) : 0), reason: 'verified-success' }
}

/** A selection is a recommendation, never permission to execute or spend. */
export function selectStrategy({ request, candidates, policy, snapshot, selectedAt = new Date().toISOString() }) {
  validateRequest(request); validatePolicy(policy); validateSnapshot(snapshot, selectedAt)
  if (!Array.isArray(candidates)) throw new Error('candidates must be an array')
  const ordered = candidates.map(c => { validateCandidate(c); return clone(c) })
    .sort((a, b) => compare(canonicalJson(arm(a)), canonicalJson(arm(b))))
  const ids = ordered.map(armId)
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate candidate arm')
  const { type, vector: context } = contextFor(request, selectedAt)
  const training = snapshot.records.map(r => {
    const result = r.taskId === request.taskId ? { reward: null, reason: 'self-task' }
      : !r.armId ? { reward: null, reason: 'unbound-selection' }
        : !ids.includes(r.armId) ? { reward: null, reason: 'different-arm' } : rewardFor(r, policy)
    return { attemptId: r.attemptId, armId: r.armId, context: r.context, ...result }
  })
  const scores = [], excluded = []
  for (const c of ordered) {
    const id = armId(c), reasons = exclusions(c, policy, type)
    if (reasons.length) { excluded.push({ armId: id, strategy: c.strategy, reasons }); continue }
    scores.push({ armId: id, strategy: c.strategy, ...scoreContext(context,
      training.filter(r => r.armId === id && r.reward !== null), policy) })
  }
  // Input order cannot affect ties; candidates are in canonical arm order.
  const best = scores.reduce((best, s) => best === null || s.score > best.score ? s : best, null)
  const chosen = best === null ? null : ordered.find(c => armId(c) === best.armId)
  const payload = { schemaVersion: 1, algorithm: ALGORITHM, featureSchema: FEATURE_SCHEMA,
    requestHash: hash(request), selectedAt, snapshotId: snapshot.snapshotId, policy: clone(policy), policyHash: hash(policy),
    candidates: ordered, context, scores, excluded, training,
    selected: chosen === null ? null : { armId: best.armId, ...arm(chosen) },
    propensity: null, propensityReason: 'Deterministic UCB; no randomized propensity', seed: null }
  return clone({ ...payload, decisionId: hash(payload) })
}
