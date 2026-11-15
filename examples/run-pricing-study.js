import { templateStudyTasks } from './template-study-tasks.js'
import { randomUUID } from 'node:crypto'
import { applyTextEdits } from '../src/orchestration/snapshot-patch.js'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { advanceFeedback, readFeedback } from '../src/feedback/index.js'
import { StrategyBank } from '../src/bank/index.js'
import { runTemplateAttempt } from '../src/orchestration/template-attempt.js'
import { armId } from '../src/selector/contracts.js'
import { pricingStudyTask } from './pricing-study-task.js'
import { createDeepSeekRuntime } from './deepseek-runtime.js'

const requestBound = 301229
export async function runPricingStudy({ out, repoDirectory, dockerImage, budget, key, fetchImpl, execute, contractOnly = false, heldoutReport }) {
  const requestsAtMost = heldoutReport ? 10 : contractOnly ? 5 : 7
  const allocation = requestBound * requestsAtMost
  if (execute !== true) return { requestsAtMost, budgetMicrounits: allocation }
  if (budget !== allocation || !out || !key?.trim() || (!fetchImpl && !/^sha256:[a-f0-9]{64}$/.test(dockerImage ?? ''))) {
    throw new Error('Supply exact preview budget, fresh output, key and pinned Docker image')
  }
  const heldout = heldoutReport ? JSON.parse(await readFile(heldoutReport, 'utf8')) : null
  const task = heldout ? { ...templateStudyTasks().find(({ request }) => request.taskId === 'event-range'),
    editablePaths: ['subject.cjs'] } : pricingStudyTask(repoDirectory)
  const directory = resolve(out)
  if (!heldout) await mkdir(directory, { mode: 0o700 })
  const bank = new StrategyBank({ dataDir: directory })
  try {
    const model = { provider: 'deepseek', model: 'deepseek-flash' }
    const models = ['deepseek/deepseek-flash']
    const templateCandidates = Object.fromEntries(['direct-v1', 'contract-v1'].map(id => {
      const strategy = bank.register({ strategyId: id, version: id === 'contract-v1' ? 4 : 3, schemaVersion: 1,
        workflow: { name: id, description: 'Pricing study', stages: [{ title: 'Implement', agents: [{ id: 'coder', prompt: 'Implement' }] }] },
        provenance: { source: 'pricing-study' } })
      return [id, { schemaVersion: 1, strategy, route: { models, tools: [], maxConcurrency: 2, tdd: true },
        taskTypes: [], estimates: { wallTimeMs: null, costMicrounits: null, quality: null, currency: 'USD', source: 'planner' } }]
    }))
    let feedback = heldout ? null : advanceFeedback(bank, { manifest: { schemaVersion: 1, experimentId: 'pricing-study',
      mode: 'online-train', splits: { train: [task.request.taskId], validation: [], test: [] } },
    cutoff: '2000-01-01T00:00:00.000Z', policy: { schemaVersion: 1, revision: 'pricing-v1',
      alpha: 0.2, lambda: 1, weights: { quality: 1, time: 0, cost: 0 },
      normalization: { wallTimeMs: 120000, costMicrounits: allocation }, currency: 'USD',
      allowedModels: models, allowedTools: [], maxConcurrency: 2, maxWallTimeMs: 150000,
      maxCostMicrounits: allocation, minQuality: null } })
    const seriesBudget = { budgetId: heldout ? 'series/heldout-event-range' : 'series/pricing-study', currency: 'USD', limitMicrounits: allocation }
    const runs = []
    const modes = heldout ? ['empty', 'trained'].map(mode => [`event-range-${mode}`, null, heldout.weighted[mode].feedback])
      : Object.entries(templateCandidates).filter(([id]) => !contractOnly || id === 'contract-v1')
    if (heldout) {
      if (heldout.taskId !== task.request.taskId) throw new Error('Held-out task mismatch')
      for (const [id, , ref] of modes) {
        const { revision } = readFeedback(bank, ref)
        if (bank.getAttempt(id) || revision.manifest.mode !== 'frozen' ||
            !revision.manifest.splits.test.includes(task.request.taskId)) throw new Error('Invalid held-out trial')
      }
    }
    for (const [id, candidate, frozen] of modes) {
      const result = await runTemplateAttempt({ ...task, textEdits: true, guardedCallsOnly: true, bank, attemptId: id, feedback: frozen ?? feedback, templateCandidates,
        selectionMethod: candidate ? { kind: 'fixed', armId: armId(candidate) } : undefined, seriesBudget, evaluationDockerImage: dockerImage,
        templateOptions: { hints: { type: 'feature' }, budgetMicrounits: allocation, model,
          resources: { agentSlots: 2, maxArtifactBytes: 24000, maxInputBytes: 48000, timeoutMs: 130000 },
          estimates: Object.fromEntries(['design', 'implement', 'write-tests', 'integrate', 'refactor']
            .map(step => [step, { seconds: 3, costMicrounits: requestBound }])) },
        allowLlm: true, createRuntime: args => createDeepSeekRuntime({ ...args, key, fetchImpl,
          outputFor: (output, envelope) => {
            if (envelope.task.startsWith('Define component') || envelope.task.startsWith('Draft tests')) return output
            const { edits } = JSON.parse(output)
            if (!Array.isArray(edits)) throw new Error('Coding response must contain an edits array')
            return JSON.stringify({ revision: randomUUID(), edits })
          },
          promptFor: envelope => {
            if (envelope.task.startsWith('Refactor')) {
              const [green] = envelope.artifacts
              const snapshot = applyTextEdits(task.baseSnapshot, JSON.parse(green.content), task.editablePaths)
              const [path] = task.editablePaths
              const instructions = 'Return JSON {edits:[{path,before,after}]}. Match before exactly once in the verified source. If no change is needed, return edits:[] to preserve behavior.'
              return instructions + '\n' + JSON.stringify({ ...envelope, artifacts: [],
                task: `Refactor only ${path}. Preserve behavior. Verified source:\n${snapshot.files[path]}` })
            }
            const isDesign = envelope.task.startsWith('Define component')
            const isTest = envelope.task.startsWith('Draft tests')
            const format = isTest
              ? 'Return only JSON {cases:[string,string,string]}. Exactly three test ideas, each under 100 characters. No test code, source code, examples or explanations. This output format overrides the task wording.'
              : isDesign ? 'Return a short JSON object containing your proposed design.'
              : 'Return JSON {edits:[{path,before,after}]}. Match before exactly once in the source. Use a small anchor and return only changed text.'
            const integration = envelope.task.startsWith('Combine')
              ? ' Apply the implementation artifact to the original source. Your final edits must export ' + (heldout ? 'eventsInRange' : 'calculateCostRange') + '. Return implementation edits even if you keep them unchanged. Do not include test files.'
              : ''
            return format + integration + '\n' + JSON.stringify({ ...envelope, task: envelope.task
              .replace(' Return JSON with revision and full files.', '')
              .replace(' Return a full snapshot with a new revision.', '') })
          } }) })
      if (result.feedbackError) throw new Error(result.feedbackError)
      feedback = result.feedback
      runs.push({ id, strategy: result.variantSelection.selectedId, wallTimeMs: result.attempt.outcome?.measured?.wallTimeMs ?? null, state: result.attempt.state, evaluation: result.attempt.evaluation?.status,
        costMicrounits: result.attempt.outcome?.calculated?.costs[0]?.microunits ?? null })
      if (bank.getEvents(id).some(e => e.eventId === 'dag/start') && bank.getBudget(seriesBudget.budgetId).heldMicrounits) break
    }
    return { directory, runs, feedback, budget: runs.some(({ id }) => bank.getEvents(id).some(e => e.eventId === 'dag/start'))
      ? bank.getBudget(seriesBudget.budgetId) : null }
  } finally { bank.close() }
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, execute: { type: 'boolean' },
    'contract-only': { type: 'boolean' }, 'heldout-report': { type: 'string' }, budget: { type: 'string' }, 'docker-image': { type: 'string' } } })
  console.log(JSON.stringify(await runPricingStudy({ ...values, budget: Number(values.budget),
    contractOnly: values['contract-only'], heldoutReport: values['heldout-report'], dockerImage: values['docker-image'], key: process.env.DEEPSEEK_API_KEY, repoDirectory: process.cwd() }), null, 2))
}
