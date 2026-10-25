import { validateWorkflow } from '../../index.js'

/** Lossless, canonical JSON for immutable records and idempotency comparisons. */
export function canonicalJson(value) {
  const seen = new Set()
  function normalize(v) {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v !== 'object' || seen.has(v)) throw new Error('Expected lossless JSON data')
    seen.add(v)
    try {
      if (Object.getOwnPropertySymbols(v).length) throw new Error('Expected JSON without symbols')
      if (Array.isArray(v)) {
        if (Object.keys(v).length !== v.length) throw new Error('Expected dense JSON array')
        return Array.from({ length: v.length }, (_, i) => {
          if (!Object.hasOwn(v, i)) throw new Error('Expected dense JSON array')
          const descriptor = Object.getOwnPropertyDescriptor(v, String(i))
          if (!Object.hasOwn(descriptor, 'value')) throw new Error('JSON accessors are unsupported')
          return normalize(descriptor.value)
        })
      }
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) {
        throw new Error('Expected plain JSON object')
      }
      const result = Object.create(null)
      for (const key of Object.keys(v).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(v, key)
        if (!Object.hasOwn(descriptor, 'value')) throw new Error('JSON accessors are unsupported')
        result[key] = normalize(descriptor.value)
      }
      return result
    } finally { seen.delete(v) }
  }
  return JSON.stringify(normalize(value))
}

export function jsonObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} requires an object`)
  canonicalJson(value)
}

export function fields(value, keys, label) {
  jsonObject(value, label)
  if (Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) {
    throw new Error(`${label} requires only ${keys.join(', ')}`)
  }
}

export function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} requires nonempty text`)
}

export function strategyRef(value) {
  fields(value, ['strategyId', 'version'], 'Strategy reference')
  text(value.strategyId, 'strategyId')
  if (!Number.isSafeInteger(value.version) || value.version < 1) throw new Error('Strategy version must be a positive safe integer')
}

export function validateStrategy(value) {
  fields(value, ['schemaVersion', 'strategyId', 'version', 'workflow', 'provenance'], 'StrategyDefinition')
  if (value.schemaVersion !== 1) throw new Error('Unsupported StrategyDefinition schemaVersion')
  strategyRef({ strategyId: value.strategyId, version: value.version })
  jsonObject(value.provenance, 'provenance')
  validateWorkflow(value.workflow)
}

export function validateRequest(value) {
  fields(value, ['schemaVersion', 'taskId', 'description', 'repo', 'baseCommit', 'testSpec', 'provenance'], 'TaskRequest')
  if (value.schemaVersion !== 1) throw new Error('Unsupported TaskRequest schemaVersion')
  for (const key of ['taskId', 'description', 'repo', 'baseCommit']) text(value[key], key)
  jsonObject(value.testSpec, 'testSpec')
  jsonObject(value.provenance, 'provenance')
}

export function validateEvaluation(value) {
  const v2 = value?.schemaVersion === 2
  fields(value, ['status', 'requiredTests', 'provenance',
    ...(v2 ? ['schemaVersion', 'correctness', 'tddCompliance', 'evidence'] : [])], 'EvaluationResult')
  if (!['success', 'failed', 'inconclusive'].includes(value.status)) throw new Error('Invalid evaluation status')
  jsonObject(value.provenance, 'provenance')
  if (v2) {
    for (const key of ['correctness', 'tddCompliance']) {
      if (!['passed', 'failed', 'inconclusive'].includes(value[key])) throw new Error(`Invalid ${key}`)
    }
    jsonObject(value.evidence, 'evidence')
    if (value.status === 'success' && (value.correctness !== 'passed' || value.tddCompliance !== 'passed')) {
      throw new Error('Success requires correctness and TDD evidence')
    }
  }
  if (!Array.isArray(value.requiredTests)) throw new Error('requiredTests must be an array')
  const ids = new Set()
  for (const check of value.requiredTests) {
    fields(check, ['id', 'status'], 'Required test')
    text(check.id, 'test id')
    if (ids.has(check.id) || !['passed', 'failed', 'skipped', 'error'].includes(check.status)) throw new Error('Invalid required test')
    ids.add(check.id)
  }
  if (value.status === 'success' && (!value.requiredTests.length || value.requiredTests.some(t => t.status !== 'passed'))) {
    throw new Error('Success requires nonempty required tests, all passed')
  }
}

export function artifactRef(value) {
  fields(value, ['sha256', 'sizeBytes'], 'Artifact reference')
  if (!/^[a-f0-9]{64}$/.test(value.sha256) || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0) {
    throw new Error('Invalid artifact reference')
  }
}
