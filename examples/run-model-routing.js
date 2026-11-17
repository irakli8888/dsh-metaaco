import { mkdir } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { StrategyBank } from '../src/bank/index.js'
import { advanceFeedback } from '../src/feedback/index.js'
import { runSkillAttempt } from '../src/orchestration/skill-attempt.js'
import { createDeepSeekRuntime } from './deepseek-runtime.js'
import { templateStudyTasks } from './template-study-tasks.js'

const flash = 'deepseek-flash'
const pro = 'deepseek-v4-pro'
const limit = 2227743 // Three Flash reservations plus one Pro reservation.
const { values } = parseArgs({ options: { execute: { type: 'boolean' }, out: { type: 'string' },
  budget: { type: 'string' }, 'docker-image': { type: 'string' } } })
if (!values.execute) {
  console.log(JSON.stringify({ requestsAtMost: 4, limitMicrounits: limit }))
} else {
  const key = process.env.DEEPSEEK_API_KEY
  const dockerImage = values['docker-image']
  if (!key?.trim() || !values.out || Number(values.budget) !== limit || !/^sha256:[a-f0-9]{64}$/.test(dockerImage ?? '')) {
    throw new Error('Supply key, fresh output, exact preview budget and pinned Docker image')
  }
  const task = templateStudyTasks().find(({ request }) => request.taskId === 'event-range')
  await mkdir(values.out, { mode: 0o700 })
  const bank = new StrategyBank({ dataDir: values.out })
  try {
    const models = [flash, pro].map(model => `deepseek/${model}`)
    const feedback = advanceFeedback(bank, { manifest: { schemaVersion: 1, experimentId: 'model-routing-v1',
      mode: 'frozen', splits: { train: [], validation: [], test: [task.request.taskId] } },
    cutoff: '2000-01-01T00:00:00.000Z', policy: { schemaVersion: 1, revision: 'routes-v1',
      alpha: 0.2, lambda: 1, weights: { quality: 1, time: 0, cost: 0 },
      normalization: { wallTimeMs: 100000, costMicrounits: limit }, currency: 'USD', allowedModels: models,
      allowedTools: [], maxConcurrency: 1, maxWallTimeMs: 100000, maxCostMicrounits: limit, minQuality: null } })
    const seriesBudget = { budgetId: 'series/model-routing', currency: 'USD', limitMicrounits: limit }
    const runs = []
    for (const mode of ['flash-only', 'mixed']) {
      const strategy = bank.register({ schemaVersion: 1, strategyId: mode, version: 1, provenance: {},
        workflow: { name: mode, description: 'Model routing pilot', stages: [{ title: 'Code', agents: [{ id: 'coder', prompt: 'Implement' }] }] } })
      const candidate = { schemaVersion: 1, strategy, route: { models: mode === 'mixed' ? models : models.slice(0, 1),
        tools: [], maxConcurrency: 1, tdd: true }, taskTypes: [],
      estimates: { wallTimeMs: null, costMicrounits: null, quality: null, currency: 'USD', source: 'pilot forecasts' } }
      const route = (model, seconds, costMicrounits, prompt) =>
        ({ model: { provider: 'deepseek', model }, seconds, costMicrounits, prompt })
      const implement = task.request.description
      const result = await runSkillAttempt({ ...task, attemptId: mode, bank, feedback, candidate, budgetMicrounits: limit,
        resources: { agentSlots: 1, timeoutMs: 80000, maxArtifactBytes: 16000, maxInputBytes: 32000 },
        skills: { implement: [route(flash, 4, 301229, implement),
          ...(mode === 'mixed' ? [route(pro, 2, 1324056, implement)] : [])],
        refactor: [route(flash, 3, 301229, 'Preserve the verified implementation. Return identical files with a different revision.')] },
        allowLlm: true, guardedCallsOnly: true, seriesBudget, evaluationDockerImage: dockerImage,
        createRuntime: args => createDeepSeekRuntime({ ...args, key }) })
      runs.push({ mode, state: result.attempt.state, timeMs: result.attempt.outcome?.measured?.wallTimeMs,
        costs: result.attempt.outcome?.calculated?.costs, choices: result.skillSelection.choices })
      if (bank.getEvents(mode).some(event => event.id === 'dag/start' || event.eventId === 'dag/start')
          && bank.getBudget(seriesBudget.budgetId).heldMicrounits > 0) break
    }
    console.log(JSON.stringify({ runs, budget: bank.getBudget(seriesBudget.budgetId) }, null, 2))
  } finally { bank.close() }
}
