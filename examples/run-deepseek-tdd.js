import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { StrategyBank } from '../src/bank/index.js'
import { advanceFeedback } from '../src/feedback/index.js'
import { armId } from '../src/selector/contracts.js'
import { runAdaptiveAttempt } from '../src/orchestration/index.js'
import { offlineExperimentConfig } from './offline-experiment-config.js'
import { createDeepSeekRuntime } from './deepseek-runtime.js'

export const requiredBudget = 602458

export async function runDeepSeekTdd({ out, budget, key, fetchImpl, dockerImage, execute }) {
  if (execute !== true) return { requestsAtMost: 2, budgetMicrounits: requiredBudget, currency: 'USD' }
  if (!Number.isSafeInteger(budget) || budget < requiredBudget) throw new Error('Explicit budget below the two-request bound')
  if (!key?.trim()) throw new Error('DEEPSEEK_API_KEY is required')
  if (!fetchImpl && !/^sha256:[a-f0-9]{64}$/.test(dockerImage ?? '')) throw new Error('Specify a local --docker-image ID for live evaluation')
  if (!out) throw new Error('Specify a fresh --out directory')
  const directory = resolve(out)
  await mkdir(directory, { mode: 0o700 })
  const bank = new StrategyBank({ dataDir: directory })
  try {
    const config = offlineExperimentConfig(bank)
    const task = config.tasks.find(task => task.request.taskId === 'addition')
    if (dockerImage) task.request.testSpec.timeoutMs = 15000
    const candidate = config.candidates[0]
    candidate.route.models = ['deepseek/deepseek-flash']
    candidate.estimates.costMicrounits = requiredBudget
    candidate.estimates.source = 'Conservative configured request bound'
    const binding = task.bindings[0]
    binding.armId = armId(candidate)
    binding.plan.resources.timeoutMs = 70000
    for (const node of binding.plan.tasks) {
      node.model = { provider: 'deepseek', model: 'deepseek-flash' }
      node.prompt = node.id === 'green'
        ? 'Implement solve(a,b) to add two numbers in subject.cjs. Starting files: ' + JSON.stringify(task.baseSnapshot.files)
        : 'Refactor if useful while preserving addition. Return the full subject.cjs from the GREEN snapshot with a new revision.'
    }
    const policy = { ...JSON.parse(bank.getArtifact(config.feedback)).policy,
      allowedModels: candidate.route.models, maxCostMicrounits: budget, maxWallTimeMs: 90000 }
    const feedback = advanceFeedback(bank, { manifest: { schemaVersion: 1, experimentId: 'deepseek-tdd',
      mode: 'frozen', splits: { train: [], validation: [], test: ['addition'] } },
    policy, cutoff: '2000-01-01T00:00:00.000Z' })
    const result = await runAdaptiveAttempt({ bank, attemptId: 'deepseek-tdd', request: task.request, feedback,
      candidates: [candidate], bindings: [binding], baseSnapshot: task.baseSnapshot, evaluationDockerImage: dockerImage, allowLlm: true,
      createRuntime: args => createDeepSeekRuntime({ ...args, key, fetchImpl }) })
    const hasBudget = bank.getEvents('deepseek-tdd').some(event => event.eventId === 'dag/start')
    return { state: result.attempt.state, evaluation: result.attempt.evaluation?.status,
      metrics: result.attempt.outcome?.calculated, budget: hasBudget ? bank.getBudget('attempt/deepseek-tdd') : null, directory }
  } finally { bank.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { execute: { type: 'boolean' }, out: { type: 'string' },
    'budget-microunits': { type: 'string' }, 'docker-image': { type: 'string' } } })
  const result = await runDeepSeekTdd({ execute: values.execute, out: values.out, dockerImage: values['docker-image'],
    budget: Number(values['budget-microunits']), key: process.env.DEEPSEEK_API_KEY })
  console.log(JSON.stringify(result, null, 2))
  if (values.execute && result.state !== 'succeeded') process.exitCode = 1
}
