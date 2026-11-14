import { calculateCost, normalizeUsage } from '../../metrics/pricing.js'

const model = 'deepseek-flash'
const maxTokens = 1024
const pricing = {
  schemaVersion: 1, id: 'deepseek-flash-peak', provider: 'deepseek', model,
  modelRevision: 'DeepSeek-V4.1-Flash-1017', currency: 'USD', effectiveAt: '2026-11-14T00:00:00Z',
  source: 'https://api-docs.deepseek.com/quick_start/pricing/',
  rates: { inputTokens: 300000, cacheReadTokens: 6000, cacheWriteTokens: 0, outputTokens: 1200000 },
}

export function createDeepSeekAdapter({ key, fetchImpl = fetch }) {
  if (!key?.trim()) throw new Error('DEEPSEEK_API_KEY is required')
  function bodyFor(options) {
    if (options.provider !== 'deepseek' || options.model !== model || options.messages?.length
      || options.tools?.length || typeof options.system !== 'string' || !options.system
      || Buffer.byteLength(options.system) > 65536) throw new Error('Unsupported DeepSeek request')
    return { model, messages: [{ role: 'user', content: options.system }],
      max_tokens: maxTokens, response_format: { type: 'json_object' }, stream: false, thinking: { type: 'disabled' } }
  }
  const adapter = {
    providerInfo(provider) { return { id: provider, name: 'DeepSeek' } },
    providerRetryPolicy() {},
    imageRequestPricing() {},
    async prepareCall(provider, id) {
      if (provider !== 'deepseek' || id !== model) throw new Error('Unsupported DeepSeek model')
      return { model: { provider, id, name: id }, stream: adapter.stream }
    },
    async *stream(options) {
      const body = bodyFor(options)
      const timeout = AbortSignal.timeout(30000)
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
      signal.throwIfAborted()
      const response = await fetchImpl('https://api.deepseek.com/chat/completions', {
        method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal,
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`DeepSeek HTTP ${response.status}`)
      }
      const reply = await response.json()
      const data = reply.usage
      const usage = normalizeUsage({ inputTokens: data?.prompt_cache_miss_tokens, cacheReadTokens: data?.prompt_cache_hit_tokens,
        outputTokens: data?.completion_tokens, cacheWriteTokens: 0, totalTokens: data?.total_tokens })
      if (reply.model !== model || [usage.inputTokens, usage.cacheReadTokens, usage.outputTokens, usage.totalTokens].includes(null)
        || usage.inputTokens + usage.cacheReadTokens !== data.prompt_tokens) throw new Error('Unexpected DeepSeek usage or model')
      yield { type: 'usage', usage }
      const choice = reply.choices?.[0]
      if (typeof choice?.message?.content === 'string') {
        yield { type: 'block-end', index: 0, block: { type: 'text', text: choice.message.content } }
      }
      const kind = { stop: 'stop', length: 'max-tokens' }[choice?.finish_reason]
      if (!kind) throw new Error('Unexpected DeepSeek finish reason')
      yield { type: 'finish', reason: { kind } }
    },
  }
  return { adapter, quote(options) {
    bodyFor(options)
    return { pricing: structuredClone(pricing), upperBoundMicrounits: calculateCost({
      inputTokens: 1000000, cacheReadTokens: 0, outputTokens: maxTokens,
    }, pricing).microunits }
  } }
}
