import { createHash } from 'node:crypto'
import { canonicalJson, fields, text, strategyRef } from '../contracts/bank.js'

export const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex')
export const clone = value => JSON.parse(canonicalJson(value))
export const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0
export const TYPES = ['bugfix', 'feature', 'refactor', 'testing', 'documentation']
export const STACKS = ['python', 'javascript', 'typescript', 'java', 'rust', 'go', 'react', 'node', 'sqlite', 'postgres']
export const FEATURE_SCHEMA = 'selector-context-v1'
export function utc(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) throw new Error('Expected canonical UTC timestamp')
  return value
}
export function number(value, label, min = 0, max = Number.MAX_SAFE_INTEGER, integer = false) {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) throw new Error(`Invalid ${label}`)
}
function list(value, label) {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}`)
  value.forEach(v => text(v, label))
  if (new Set(value).size !== value.length) throw new Error(`Duplicate ${label}`)
}
function currency(value) {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) throw new Error('Invalid currency')
}
export function validatePolicy(p) {
  fields(p, ['schemaVersion', 'revision', 'alpha', 'lambda', 'weights', 'normalization', 'currency',
    'allowedModels', 'allowedTools', 'maxConcurrency', 'maxWallTimeMs', 'maxCostMicrounits', 'minQuality'], 'Selector policy')
  if (p.schemaVersion !== 1) throw new Error('Unsupported policy version')
  text(p.revision, 'revision'); currency(p.currency)
  number(p.alpha, 'alpha', 0, 100); number(p.lambda, 'lambda', 1e-6, 1e6)
  fields(p.weights, ['quality', 'time', 'cost'], 'weights')
  Object.values(p.weights).forEach(v => number(v, 'weights', 0, 1))
  if (Math.abs(Object.values(p.weights).reduce((a, b) => a + b, 0) - 1) > 1e-12) throw new Error('weights must sum to 1')
  fields(p.normalization, ['wallTimeMs', 'costMicrounits'], 'normalization')
  number(p.normalization.wallTimeMs, 'time normalization', Number.EPSILON)
  number(p.normalization.costMicrounits, 'cost normalization', 1, Number.MAX_SAFE_INTEGER, true)
  list(p.allowedModels, 'allowedModels'); list(p.allowedTools, 'allowedTools')
  number(p.maxConcurrency, 'maxConcurrency', 1, Number.MAX_SAFE_INTEGER, true)
  if (p.maxWallTimeMs !== null) number(p.maxWallTimeMs, 'maxWallTimeMs')
  if (p.maxCostMicrounits !== null) number(p.maxCostMicrounits, 'maxCostMicrounits', 0, Number.MAX_SAFE_INTEGER, true)
  if (p.minQuality !== null) number(p.minQuality, 'minQuality', 0, 1)
}
export function validateCandidate(c) {
  fields(c, ['schemaVersion', 'strategy', 'route', 'taskTypes', 'estimates'], 'Selector candidate')
  if (c.schemaVersion !== 1) throw new Error('Unsupported candidate version')
  strategyRef(c.strategy)
  fields(c.route, ['models', 'tools', 'maxConcurrency', 'tdd'], 'route')
  list(c.route.models, 'models'); list(c.route.tools, 'tools')
  if (!c.route.models.length || typeof c.route.tdd !== 'boolean') throw new Error('Invalid route')
  number(c.route.maxConcurrency, 'concurrency', 1, Number.MAX_SAFE_INTEGER, true)
  list(c.taskTypes, 'taskTypes')
  if (c.taskTypes.some(v => !TYPES.includes(v))) throw new Error('Invalid taskTypes')
  fields(c.estimates, ['wallTimeMs', 'costMicrounits', 'quality', 'currency', 'source'], 'estimates')
  text(c.estimates.source, 'estimate source'); currency(c.estimates.currency)
  if (c.estimates.wallTimeMs !== null) number(c.estimates.wallTimeMs, 'wallTimeMs')
  if (c.estimates.costMicrounits !== null) number(c.estimates.costMicrounits, 'costMicrounits', 0, Number.MAX_SAFE_INTEGER, true)
  if (c.estimates.quality !== null) number(c.estimates.quality, 'quality', 0, 1)
}
export function arm(c) {
  return { strategy: c.strategy, route: { ...c.route, models: [...c.route.models].sort(compare), tools: [...c.route.tools].sort(compare) } }
}
export const armId = c => hash(arm(c))
