import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { advanceFeedback } from '../src/feedback/index.js'
import { StrategyBank } from '../src/bank/index.js'
import { runTemplateAttempt } from '../src/orchestration/template-attempt.js'
import { armId } from '../src/selector/contracts.js'
import { pricingStudyTask } from './pricing-study-task.js'
import { createDeepSeekRuntime } from './deepseek-runtime.js'

const requestBound = 301229
export async function runPricingStudy({ out, repoDirectory, dockerImage, budget, key, fetchImpl, execute, contractOnly = false }) {
  const requestsAtMost = contractOnly ? 5 : 7
  const allocation = requestBound * requestsAtMost
  if (execute !== true) return { requestsAtMost, budgetMicrounits: allocation }
  if (budget !== allocation || !out || !key?.trim() || (!fetchImpl && !/^sha256:[a-f0-9]{64}$/.test(dockerImage ?? ''))) {
    throw new Error('Supply exact preview budget, fresh output, key and pinned Docker image')
  }
  const task = pricingStudyTask(repoDirectory)
  const directory = resolve(out)
  await mkdir(directory, { mode: 0o700 })
  const bank = new StrategyBank({ dataDir: directory })
  try {
    const model = { provider: 'deepseek', model: 'deepseek-flash' }
    const models = ['deepseek/deepseek-flash']
    const templateCandidates = Object.fromEntries(['direct-v1', 'contract-v1'].map(id => {
      const strategy = bank.register({ strategyId: id, version: id === 'contract-v1' ? 2 : 1, schemaVersion: 1,
        workflow: { name: id, description: 'Pricing study', stages: [{ title: 'Implement', agents: [{ id: 'coder', prompt: 'Implement' }] }] },
        provenance: { source: 'pricing-study' } })
      return [id, { schemaVersion: 1, strategy, route: { models, tools: [], maxConcurrency: 2, tdd: true },
        taskTypes: [], estimates: { wallTimeMs: null, costMicrounits: null, quality: null, currency: 'USD', source: 'planner' } }]
    }))
    let feedback = advanceFeedback(bank, { manifest: { schemaVersion: 1, experimentId: 'pricing-study',
      mode: 'online-train', splits: { train: [task.request.taskId], validation: [], test: [] } },
    cutoff: '2000-01-01T00:00:00.000Z', policy: { schemaVersion: 1, revision: 'pricing-v1',
      alpha: 0.2, lambda: 1, weights: { quality: 1, time: 0, cost: 0 },
      normalization: { wallTimeMs: 120000, costMicrounits: allocation }, currency: 'USD',
      allowedModels: models, allowedTools: [], maxConcurrency: 2, maxWallTimeMs: 150000,
      maxCostMicrounits: allocation, minQuality: null } })
    const seriesBudget = { budgetId: 'series/pricing-study', currency: 'USD', limitMicrounits: allocation }
    const runs = []
    for (const [id, candidate] of Object.entries(templateCandidates)) {
      if (contractOnly && id !== 'contract-v1') continue
      const result = await runTemplateAttempt({ ...task, textEdits: true, bank, attemptId: id, feedback, templateCandidates,
        selectionMethod: { kind: 'fixed', armId: armId(candidate) }, seriesBudget, evaluationDockerImage: dockerImage,
        templateOptions: { hints: { type: 'feature' }, budgetMicrounits: allocation, model,
          resources: { agentSlots: 2, maxArtifactBytes: 24000, maxInputBytes: 48000, timeoutMs: 130000 },
          estimates: Object.fromEntries(['design', 'implement', 'write-tests', 'integrate', 'refactor']
            .map(step => [step, { seconds: 3, costMicrounits: requestBound }])) },
        allowLlm: true, createRuntime: args => createDeepSeekRuntime({ ...args, key, fetchImpl,
          promptFor: envelope => {
            const isDesign = envelope.task.startsWith('Define component')
            const isTest = envelope.task.startsWith('Draft tests')
            const format = isTest
              ? 'Return only JSON {cases:[string,string,string]}. Exactly three test ideas, each under 100 characters. No test code, source code, examples or explanations. This output format overrides the task wording.'
              : isDesign ? 'Return a short JSON object containing your proposed design.'
              : 'Return JSON {revision,edits:[{path,before,after}]}. Match before exactly once in the source. Use a small anchor and return only changed text. For REFACTOR, use the GREEN edits to reconstruct the current source. Return edits:[] to preserve verified code, with a new revision.'
            return format + '\n' + JSON.stringify({ ...envelope, task: envelope.task
              .replace(' Return JSON with revision and full files.', '')
              .replace(' Return a full snapshot with a new revision.', '') })
          } }) })
      if (result.feedbackError) throw new Error(result.feedbackError)
      feedback = result.feedback
      runs.push({ id, state: result.attempt.state, evaluation: result.attempt.evaluation?.status })
      if (bank.getEvents(id).some(e => e.eventId === 'dag/start') && bank.getBudget(seriesBudget.budgetId).heldMicrounits) break
    }
    return { directory, runs, feedback, budget: runs.some(({ id }) => bank.getEvents(id).some(e => e.eventId === 'dag/start'))
      ? bank.getBudget(seriesBudget.budgetId) : null }
  } finally { bank.close() }
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, execute: { type: 'boolean' },
    'contract-only': { type: 'boolean' }, budget: { type: 'string' }, 'docker-image': { type: 'string' } } })
  console.log(JSON.stringify(await runPricingStudy({ ...values, budget: Number(values.budget),
    contractOnly: values['contract-only'], dockerImage: values['docker-image'], key: process.env.DEEPSEEK_API_KEY, repoDirectory: process.cwd() }), null, 2))
}
