import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { StrategyBank } from '../src/bank/index.js'
import { advanceFeedback, readFeedback } from '../src/feedback/index.js'
import { armId } from '../src/selector/contracts.js'
import { prepareExperiment, runExperiment } from '../src/experiments/index.js'
import { offlineExperimentConfig } from './offline-experiment-config.js'
import { createDeepSeekRuntime } from './deepseek-runtime.js'

const { values } = parseArgs({ options: { execute: { type: 'boolean' }, out: { type: 'string' },
  'docker-image': { type: 'string' }, 'budget-microunits': { type: 'string' } } })
if (!values.execute) {
  console.log('Pilot: two arithmetic fixtures, two seeds, seven modes, one DeepSeek model.')
} else {
  const key = process.env.DEEPSEEK_API_KEY
  const evaluationDockerImage = values['docker-image']
  const limitMicrounits = Number(values['budget-microunits'])
  if (!key?.trim() || !values.out || !/^sha256:[a-f0-9]{64}$/.test(evaluationDockerImage ?? '')
    || !Number.isSafeInteger(limitMicrounits) || limitMicrounits < 602458 || limitMicrounits > 9499753) {
    throw new Error('Supply a key, new output directory, Docker image ID and budget within the remaining Lenovo allocation')
  }
  const directory = resolve(values.out)
  await mkdir(directory, { mode: 0o700 })
  const bank = new StrategyBank({ dataDir: directory })
  try {
    const config = offlineExperimentConfig(bank)
    const { revision } = readFeedback(bank, config.feedback)
    const models = ['deepseek/deepseek-flash']
    const candidates = config.candidates.map(c => ({ ...c, route: { ...c.route, models },
      estimates: { ...c.estimates, wallTimeMs: 90000, costMicrounits: 602458, source: 'Shared conservative request bound' } }))
    const tasks = config.tasks.map(task => {
      task.request.testSpec.timeoutMs = 15000
      const bindings = task.bindings.map((binding, index) => {
        const plan = binding.plan
        plan.resources.timeoutMs = 100000
        for (const node of plan.tasks) {
          node.model = { provider: 'deepseek', model: 'deepseek-flash' }
          node.prompt = node.id === 'green'
            ? `Implement solve(a,b) for ${task.request.taskId}. Return subject.cjs with a CommonJS solve export. Starting files: ${JSON.stringify(task.baseSnapshot.files)}. ${index === 0 ? 'Prefer a minimal implementation.' : 'Use a named solve function.'}`
            : 'Preserve behavior and return the complete subject.cjs from the GREEN snapshot with a new revision.'
        }
        return { ...binding, armId: armId(candidates[index]), plan }
      })
      return { ...task, bindings, durations: Object.fromEntries(bindings.map(b => [b.armId, { green: 1, refactor: 1 }])) }
    })
    const feedback = advanceFeedback(bank, { manifest: { ...revision.manifest, experimentId: 'lenovo-pilot' },
      cutoff: revision.cutoff, policy: { ...revision.policy, allowedModels: models, maxWallTimeMs: 120000, maxCostMicrounits: 610000 } })
    const solverSource = fileURLToPath(new URL('../python/vendor/', import.meta.url))
    const seriesBudget = { budgetId: 'series/lenovo-pilot', currency: 'USD', limitMicrounits }
    const runtimeConfig = { provider: 'deepseek', model: 'deepseek-flash', evaluationDockerImage, seriesBudget }
    const ref = await prepareExperiment(bank, { experimentId: 'lenovo-pilot', candidates, tasks, feedback,
      seeds: config.seeds, fixedArmId: armId(candidates[0]), runtimeConfig, solverSource })
    const report = await runExperiment(bank, ref, { journal: join(directory, 'runs.jsonl'), solverSource,
      runtimeConfig, seriesBudget, evaluationDockerImage, allowLlm: true, createRuntime: args => createDeepSeekRuntime({ ...args, key }) })
    await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 })
    console.log(JSON.stringify({ directory, summary: report.summary }, null, 2))
  } finally { bank.close() }
}
