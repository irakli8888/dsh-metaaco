import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { calculateCost } from '../src/metrics/pricing.js'

const model = 'deepseek-flash'
const maxTokens = 16
// Published peak tariff. Reconfirm before authorizing a live run.
const pricing = { schemaVersion: 1, id: 'deepseek-flash-peak', provider: 'deepseek', model,
  modelRevision: 'DeepSeek-V4.1-Flash-1017', currency: 'USD', effectiveAt: '2026-11-14T00:00:00Z',
  source: 'https://api-docs.deepseek.com/quick_start/pricing/',
  rates: { inputTokens: 300000, cacheReadTokens: 6000, cacheWriteTokens: 0, outputTokens: 1200000 } }
const upperBoundMicrounits = calculateCost({ inputTokens: 1000000, cacheReadTokens: 0, outputTokens: maxTokens }, pricing).microunits

export async function runSmoke({ execute = false, budget, key, fetchImpl = fetch } = {}) {
  const preview = { model, maxTokens, upperBoundMicrounits, currency: 'USD' }
  if (execute !== true) return preview
  if (!Number.isSafeInteger(budget) || budget < upperBoundMicrounits) throw new Error('Explicit budget below the conservative request bound')
  if (!key?.trim()) throw new Error('DEEPSEEK_API_KEY is required')
  const response = await fetchImpl('https://api.deepseek.com/chat/completions', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with OK.' }],
      max_tokens: maxTokens, thinking: { type: 'disabled' }, stream: false }),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`DeepSeek HTTP ${response.status}`)
  }
  const body = await response.json()
  const data = body.usage
  const usage = { inputTokens: data?.prompt_cache_miss_tokens, cacheReadTokens: data?.prompt_cache_hit_tokens,
    outputTokens: data?.completion_tokens, cacheWriteTokens: 0, totalTokens: data?.total_tokens }
  if (body.model !== model || !Object.values(usage).every(n => Number.isSafeInteger(n) && n >= 0)
    || usage.inputTokens + usage.cacheReadTokens !== data.prompt_tokens || usage.outputTokens > maxTokens
    || data.prompt_tokens > 1000000) throw new Error('Unexpected model or usage. Check provider billing before repeating.')
  return { ...preview, usage, finishReason: body.choices?.[0]?.finish_reason ?? null,
    estimatedPeakCostMicrounits: calculateCost(usage, pricing).microunits }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { execute: { type: 'boolean' }, 'budget-microunits': { type: 'string' } } })
  try {
    console.log(JSON.stringify(await runSmoke({ execute: values.execute,
      budget: Number(values['budget-microunits']), key: process.env.DEEPSEEK_API_KEY }), null, 2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
