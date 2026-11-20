import { mkdir, readFile, writeFile, appendFile, rename } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { StrategyBank } from '../src/bank/index.js'
import { advanceFeedback } from '../src/feedback/index.js'
import { runAdaptiveAttempt } from '../src/orchestration/index.js'
import { armId } from '../src/selector/contracts.js'
import { createDeepSeekRuntime } from './deepseek-runtime.js'

import { task, models, catalog } from './stock-route-catalog.js'
const digests = catalog.map(({plan}) => createHash('sha256').update(JSON.stringify(plan)).digest('hex'))
if (catalog.length !== 1836 || new Set(digests).size !== catalog.length) throw Error('Invalid exhaustive catalog')
const [, , mode, out, image, workerCount = '1', max = '1836', subset = 'all'] = process.argv
if (!['all', 'components'].includes(subset) || !/^[1-4]$/.test(workerCount) ||
    !Number.isInteger(Number(max)) || Number(max) < 1 || Number(max) > catalog.length) {
  throw Error('Expected workers 1–4, route limit 1–1836 and subset all or components')
}
const eligible = i => subset === 'all' || catalog[i].plan.tasks.some(t => t.id === 'implement-stock')
if (mode === '--preview') {
  console.log(JSON.stringify({ routes: catalog.length, nodesIfAllReachEnd: catalog.reduce((n, item) => n + item.plan.tasks.length, 0),
    monolithic: catalog.filter(({plan}) => plan.tasks.some(t => t.id === 'implement')).length }))
  process.exit(0)
}
if (mode !== '--execute' || !out || !process.env.DEEPSEEK_API_KEY || !/^sha256:[a-f0-9]{64}$/.test(image ?? '')) throw Error('Invalid execution configuration')
await mkdir(out, { recursive: true, mode: 0o700 })
const manifest = { schemaVersion: 2, subset, routes: catalog.filter((_,i) => eligible(i)).length, dockerImage: image, workers: Number(workerCount), task: task.request, baseSnapshot: task.baseSnapshot, routeHashes: digests }
const manifestText = JSON.stringify(manifest, null, 2)
try { await writeFile(out + '/manifest.json', manifestText, { flag: 'wx' }) }
catch (error) { if (error.code !== 'EEXIST' || await readFile(out + '/manifest.json', 'utf8') !== manifestText) throw error }
const bank = new StrategyBank({ dataDir: out + '/bank' })
const policy = { schemaVersion: 1, revision: 'exhaustive-v1', alpha: 0.2, lambda: 1, weights: { quality: 1, time: 0, cost: 0 },
  normalization: { wallTimeMs: 120000, costMicrounits: 1000000 }, currency: 'USD', allowedModels: models.map(m => 'deepseek/' + m),
  allowedTools: [], maxConcurrency: 2, maxWallTimeMs: 120000, maxCostMicrounits: 9 * 1324056, minQuality: null }
const feedback = advanceFeedback(bank, { manifest: { schemaVersion: 1, experimentId: 'stock-exhaustive-v2', mode: 'frozen',
  splits: { train: [task.request.taskId], validation: [], test: [] } }, cutoff: '2000-01-01T00:00:00.000Z', policy })
const strategy = bank.register({ schemaVersion: 1, strategyId: 'fixed-route', version: 1, provenance: {},
  workflow: { name: 'fixed-route', description: 'Exhaustive measured baseline', stages: [{ title: 'Code', agents: [{ id: 'coder', prompt: 'Implement' }] }] } })
const candidate = { schemaVersion: 1, strategy, route: { models: policy.allowedModels, tools: [], maxConcurrency: 2, tdd: true }, taskTypes: [],
  estimates: { wallTimeMs: 80000, costMicrounits: 11916504, quality: null, currency: 'USD', source: 'exhaustive route catalog' } }
const idFor = i => 'route-' + String(i + 1).padStart(4, '0')
const rows = new Map()
function record(i, attempt) {
  const measured = attempt.outcome?.measured
  const cost = attempt.outcome?.calculated?.costs.find(c => c.currency === 'USD')
  const terminal = bank.getEvents(attempt.attemptId).find(e => e.eventId === 'dag/finish')?.payload
  const reason = terminal?.tasks.find(t => t.reason && t.state !== 'blocked')?.reason?.split('\n')[0]
  const row = { route: attempt.attemptId, hash: digests[i], state: attempt.state, evaluation: attempt.evaluation?.status ?? null,
    wallTimeMs: measured?.wallTimeMs ?? null, costMicrounits: cost?.microunits ?? null, knownMicrounits: cost?.knownMicrounits ?? 0,
    calls: measured?.observedCallCount ?? 0, reason: reason ?? attempt.evaluation?.provenance?.reason ?? null,
    tasks: catalog[i].plan.tasks.map(({id, model, dependsOn}) => ({id, model: model.model, dependsOn})) }
  rows.set(i, row)
  return row
}
const pid = process.pid
async function report() {
  const all = [...rows.values()]
  const passed = all.filter(r => r.state === 'succeeded' && r.evaluation === 'success')
  const ranked = passed.filter(r => r.wallTimeMs !== null && r.costMicrounits !== null)
  const frontier = ranked.filter(r => !ranked.some(s => s.wallTimeMs <= r.wallTimeMs && s.costMicrounits <= r.costMicrounits &&
    (s.wallTimeMs < r.wallTimeMs || s.costMicrounits < r.costMicrounits))).sort((a,b) => a.wallTimeMs-b.wallTimeMs)
  const states = Object.fromEntries([...new Set(all.map(r => r.state))].map(state => [state, all.filter(r => r.state === state).length]))
  const known = all.reduce((n,r) => n + r.knownMicrounits, 0)
  const dollars = n => '$' + (n / 1e6).toFixed(6)
  const lines = ['# Резервирование товара — полный перебор маршрутов', '', `Покрытие — ${all.length} из ${manifest.routes}. Прошли обязательную приёмку — ${passed.length}. Состояния — ${JSON.stringify(states)}.`,
    `Зафиксировано вызовов — ${all.reduce((n,r) => n+r.calls,0)}. Известная расчётная стоимость — ${dollars(known)}. Попытки с неполной стоимостью — ${all.filter(r => r.costMicrounits === null).length}.`, '',
    'Исходный код, обязательные тесты и образ Docker закреплены в manifest.json. Каждый маршрут выполняется один раз. Измеренное время включает проверку; стоимость рассчитана по тарифу и токенам. Этап подготовки тестов не изменяет обязательный набор приёмки.', '',
    '## Успешные маршруты, лучшие по времени и стоимости', '', '| Маршрут | Время, с | Стоимость |', '|---|---:|---:|',
    ...frontier.map(r => `| ${r.route} | ${(r.wallTimeMs / 1000).toFixed(3)} | ${dollars(r.costMicrounits)} |`), '',
    'Подробные результаты, шаги и модели приведены в results.jsonl. Артефакты кода и журнал тестов хранятся в bank/.']
  const path = out + '/report.tmp.' + pid
  await writeFile(path, lines.join('\n') + '\n')
  await rename(path, out + '/report.md')
}
try {
  const interrupted = catalog.map((_,i) => idFor(i)).filter(id => bank.getAttempt(id)?.state === 'running')
  if (interrupted.length) bank.recoverInterrupted(interrupted, 'Previous exclusive runner stopped')
  for (let i=0;i<catalog.length;i++) {
    const attempt = bank.getAttempt(idFor(i))
    if (attempt) record(i, attempt)
  }
  await writeFile(out + '/results.jsonl', [...rows.values()].map(r => JSON.stringify(r)+'\n').join(''))
  await report()
  let index = 0
  let writes = Promise.resolve()
  async function work() {
    while (index < Number(max)) {
      const i = index++
      if (rows.has(i) || !eligible(i)) continue
      const { green, plan } = catalog[i]
      const result = await runAdaptiveAttempt({ ...task, bank, feedback, attemptId: idFor(i), candidates: [candidate],
        bindings: [{ schemaVersion: 1, armId: armId(candidate), plan, greenTaskId: green, refactorTaskId: 'refactor' }],
        templateSelection: { schemaVersion: 1, method: 'exhaustive', routeHash: digests[i] },
        componentTaskIds: plan.tasks.filter(t => t.id.startsWith('implement-')).map(t => t.id),
        evaluationDockerImage: image, allowLlm: true, guardedCallsOnly: true,
        createRuntime: args => createDeepSeekRuntime({ ...args, key: process.env.DEEPSEEK_API_KEY }) })
      const row = record(i, result.attempt)
      writes = writes.then(async () => {
        await appendFile(out + '/results.jsonl', JSON.stringify(row) + '\n')
        await report()
      })
      await writes
    }
  }
  const workers = await Promise.allSettled(Array.from({length: Number(workerCount)}, work))
  const failed = workers.find(w => w.status === 'rejected')
  if (failed) throw failed.reason
} finally { bank.close() }
