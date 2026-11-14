import { createHash } from 'node:crypto'
import { canonicalJson, jsonObject, fields, text, validateRequest } from '../contracts/bank.js'

const VERSION = 'rules-v1'
const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex')
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0
const types = {
  bugfix: /\b(fix|bug|regression)\b|исправ\p{L}*|ошиб\p{L}*/iu,
  feature: /\b(add|implement|feature)\b|добав\p{L}*|реализ\p{L}*/iu,
  refactor: /\brefactor\w*\b|рефактор\p{L}*/iu,
  testing: /\b(write|add) tests?\b|написать тест\p{L}*/iu,
  documentation: /\bdocument\w*\b|документ\p{L}*/iu,
}
const stacks = {
  python: /\bpython\b/iu, javascript: /\bjavascript\b/iu,
  typescript: /\btypescript\b/iu, java: /\bjava\b/iu,
  rust: /\brust\b/iu, go: /\bgolang\b/iu,
  react: /\breact\b/iu, node: /\bnode(?:\.js)?\b/iu,
  sqlite: /\bsqlite\b/iu, postgres: /\b(postgres|postgresql)\b/iu,
}

function utc(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) throw new Error('Expected canonical UTC timestamp')
  return value
}
function strings(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} requires an array`)
  for (const item of value) text(item, label)
  return [...new Set(value.map(item => item.trim().toLowerCase()))].sort(compare)
}
function hintValues(hints) {
  jsonObject(hints, 'hints')
  for (const key of Object.keys(hints)) {
    if (!['type', 'complexity', 'stack', 'requirements'].includes(key)) throw new Error(`Unknown hint: ${key}`)
  }
  if (hints.type !== undefined && !Object.hasOwn(types, hints.type)) throw new Error('Invalid type hint')
  if (hints.complexity !== undefined && !['low', 'medium', 'high'].includes(hints.complexity)) throw new Error('Invalid complexity hint')
  return { ...hints, ...(hints.stack === undefined ? {} : { stack: strings(hints.stack, 'stack') }),
    requirements: strings(hints.requirements ?? [], 'requirements') }
}
const unknown = reason => ({ value: null, source: 'unknown', confidence: null, reason })
const declared = value => ({ value, source: 'declared', confidence: null, reason: 'Caller declaration; not independently verified' })
const inferred = value => ({ value, source: 'rules', confidence: 'heuristic', reason: 'Description keyword match; not a calibrated probability' })

/** Computes only pre-execution features; never reads files or invokes a provider. */
export function analyzeTask(request, { hints = {}, analyzedAt = new Date().toISOString() } = {}) {
  validateRequest(request)
  utc(analyzedAt)
  const normalized = hintValues(hints)
  const matches = Object.keys(types).filter(key => types[key].test(request.description))
  const stack = Object.keys(stacks).filter(key => stacks[key].test(request.description)).sort(compare)
  const type = normalized.type ? declared(normalized.type)
    : matches.length === 1 ? inferred(matches[0]) : unknown(matches.length ? 'Ambiguous task types' : 'No task type evidence')
  const complexity = normalized.complexity ? declared(normalized.complexity) : unknown('Complexity requires an explicit scope assessment')
  const technology = normalized.stack?.length ? declared(normalized.stack)
    : normalized.stack ? unknown('Caller supplied no stack') : stack.length ? inferred(stack) : unknown('No stack evidence')
  return { schemaVersion: 1, analyzerVersion: VERSION, taskId: request.taskId, analyzedAt,
    requestHash: hash(request), inputHash: hash({ request, hints: normalized }),
    classification: { type, complexity }, stack: technology, requirements: normalized.requirements,
    estimates: { wallTimeMs: unknown('No duration estimator'), cost: unknown('No cost estimator'),
      quality: unknown('No quality estimator') },
    provenance: { source: 'offline-rules', featureSchema: 'task-features-v1' } }
}

/** Freeze caller-approved training history before evaluation. Does not copy outcomes. */
export function createHistorySnapshot(bank, { trainingTaskIds, cutoff } = {}) {
  if (!Array.isArray(trainingTaskIds)) throw new Error('trainingTaskIds must be explicit')
  for (const id of trainingTaskIds) text(id, 'trainingTaskIds')
  const ids = [...new Set(trainingTaskIds)].sort(compare)
  utc(cutoff)
  const allowed = new Set(ids), tasks = new Map()
  // listAttempts reads one consistent SQLite transaction.
  for (const attempt of bank.listAttempts()) {
    if (!allowed.has(attempt.request.taskId) || attempt.state === 'running'
      || !attempt.finishedAt || Date.parse(attempt.finishedAt) >= Date.parse(cutoff)) continue
    let entry = tasks.get(attempt.request.taskId)
    if (!entry) {
      entry = { request: attempt.request, attempts: [] }
      tasks.set(attempt.request.taskId, entry)
    }
    entry.attempts.push({ attemptId: attempt.attemptId, state: attempt.state,
      strategy: attempt.strategy, finishedAt: attempt.finishedAt })
  }
  const entries = [...tasks.values()].sort((a, b) => compare(a.request.taskId, b.request.taskId))
  for (const entry of entries) entry.attempts.sort((a, b) => compare(a.attemptId, b.attemptId))
  const payload = { schemaVersion: 1, analyzerVersion: VERSION, split: 'train', cutoff, trainingTaskIds: ids, entries }
  return JSON.parse(canonicalJson({ ...payload, snapshotId: hash(payload) }))
}

function validateSnapshot(snapshot) {
  fields(snapshot, ['schemaVersion', 'analyzerVersion', 'split', 'cutoff', 'trainingTaskIds', 'entries', 'snapshotId'], 'History snapshot')
  const { snapshotId, ...payload } = snapshot
  if (snapshot.schemaVersion !== 1 || snapshot.analyzerVersion !== VERSION || snapshot.split !== 'train'
    || snapshotId !== hash(payload)) throw new Error('Invalid history snapshot version or hash')
  utc(snapshot.cutoff)
  if (!Array.isArray(snapshot.trainingTaskIds) || !Array.isArray(snapshot.entries)) throw new Error('Invalid snapshot entries')
  const seen = new Set()
  for (const entry of snapshot.entries) {
    fields(entry, ['request', 'attempts'], 'Snapshot entry')
    validateRequest(entry.request)
    if (!snapshot.trainingTaskIds.includes(entry.request.taskId) || seen.has(entry.request.taskId)) throw new Error('Invalid snapshot task')
    seen.add(entry.request.taskId)
    if (!Array.isArray(entry.attempts) || !entry.attempts.length) throw new Error('Invalid snapshot attempts')
    for (const attempt of entry.attempts) {
      fields(attempt, ['attemptId', 'state', 'strategy', 'finishedAt'], 'Snapshot attempt')
      if (!['succeeded', 'failed', 'cancelled', 'timeout', 'interrupted', 'inconclusive'].includes(attempt.state)
        || Date.parse(utc(attempt.finishedAt)) >= Date.parse(snapshot.cutoff)) throw new Error('Invalid snapshot attempt')
    }
  }
}

function features(analysis) {
  // Outcome-independent categorical tokens. Unknown values contribute no evidence.
  return new Set([
    ...(analysis.classification.type.value ? [`type:${analysis.classification.type.value}`] : []),
    ...(analysis.stack.value ?? []).map(value => `stack:${value}`),
  ])
}

/** Jaccard similarity, deterministic ties; no quality/ranking claims about strategies. */
export function findSimilarTasks(request, snapshot, { limit = 10 } = {}) {
  validateSnapshot(snapshot)
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('limit must be a positive safe integer')
  const query = analyzeTask(request, { analyzedAt: snapshot.cutoff })
  const queryFeatures = features(query)
  const matches = []
  for (const entry of snapshot.entries) {
    if (entry.request.taskId === request.taskId) continue
    const other = features(analyzeTask(entry.request, { analyzedAt: snapshot.cutoff }))
    const sharedFeatures = [...queryFeatures].filter(value => other.has(value)).sort(compare)
    if (!sharedFeatures.length) continue
    matches.push({ taskId: entry.request.taskId,
      score: sharedFeatures.length / new Set([...queryFeatures, ...other]).size,
      sharedFeatures, attemptIds: entry.attempts.map(a => a.attemptId) })
  }
  matches.sort((a, b) => b.score - a.score || compare(a.taskId, b.taskId))
  return { schemaVersion: 1, algorithm: 'categorical-jaccard-v1', snapshotId: snapshot.snapshotId,
    requestHash: query.requestHash, limit, matches: matches.slice(0, limit) }
}
