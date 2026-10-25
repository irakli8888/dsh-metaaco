import { fields, jsonObject, text } from '../contracts/bank.js'

export const tokenFields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens']
export const billedFields = tokenFields.slice(0, 4)
export function nonnegative(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative safe integer`)
}
export function normalizeUsage(value) {
  if (value === null || value === undefined) return Object.fromEntries(tokenFields.map(key => [key, null]))
  jsonObject(value, 'usage')
  if (Object.keys(value).some(key => !tokenFields.includes(key))) throw new Error('Unknown usage field')
  const result = Object.fromEntries(tokenFields.map(key => [key, value[key] ?? null]))
  for (const [key, count] of Object.entries(result)) if (count !== null) nonnegative(count, key)
  if (result.reasoningTokens !== null && result.outputTokens !== null && result.reasoningTokens > result.outputTokens) {
    throw new Error('Reasoning tokens must be included in outputTokens')
  }
  if (result.totalTokens !== null && billedFields.every(key => result[key] !== null)
    && billedFields.reduce((n, key) => n + BigInt(result[key]), 0n) !== BigInt(result.totalTokens)) {
    throw new Error('Provider totalTokens contradict disjoint input/cache/output counts')
  }
  return result
}
export function validatePrice(price) {
  fields(price, ['schemaVersion', 'id', 'provider', 'model', 'modelRevision', 'currency', 'effectiveAt', 'source', 'rates'], 'Pricing snapshot')
  if (price.schemaVersion !== 1) throw new Error('Unsupported pricing schema')
  for (const key of ['id', 'provider', 'model', 'modelRevision', 'currency', 'source']) text(price[key], key)
  if (!/^[A-Z]{3}$/.test(price.currency) || typeof price.effectiveAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(price.effectiveAt)
    || !Number.isFinite(Date.parse(price.effectiveAt))) throw new Error('Invalid pricing currency/UTC date')
  fields(price.rates, billedFields, 'Rates in microunits per million tokens')
  for (const value of Object.values(price.rates)) nonnegative(value, 'rate')
}
export function calculateCost(usage, price) {
  const counts = normalizeUsage(usage)
  if (price === null) return { currency: null, microunits: null, reason: 'Pricing snapshot unavailable' }
  validatePrice(price)
  let numerator = 0n
  for (const key of billedFields) {
    if (price.rates[key] === 0) continue
    if (counts[key] === null) return { currency: price.currency, microunits: null, reason: `Usage unavailable: ${key}` }
    numerator += BigInt(counts[key]) * BigInt(price.rates[key])
  }
  const amount = (numerator + 999999n) / 1000000n
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Calculated cost exceeds safe integer range')
  return { currency: price.currency, microunits: Number(amount), reason: null }
}
