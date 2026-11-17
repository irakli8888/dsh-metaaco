import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { parseArgs } from 'node:util'
import { StrategyBank } from '../src/bank/index.js'
import { advanceFeedback } from '../src/feedback/index.js'
import { templateStudyTasks } from './template-study-tasks.js'

const { values } = parseArgs({ options: { out: { type: 'string' }, 'docker-image': { type: 'string' } } })
if (!values.out || !/^sha256:[a-f0-9]{64}$/.test(values['docker-image'] ?? '')) {
  throw new Error('Usage: node examples/prepare-skill-job.js --out NEW_DIR --docker-image sha256:IMAGE_ID')
}
const directory = resolve(values.out), bankDir = join(directory, 'bank')
await mkdir(directory, { mode: 0o700 })
const bank = new StrategyBank({ dataDir: bankDir })
try {
  const { request, baseSnapshot } = templateStudyTasks().find(task => task.request.taskId === 'event-range')
  const budgetMicrounits = 602458
  const models = ['deepseek/deepseek-flash']
  const strategy = bank.register({ schemaVersion: 1, strategyId: 'chat-demo', version: 1, provenance: {},
    workflow: { name: 'chat-demo', description: 'Harness skill demo',
      stages: [{ title: 'Work', agents: [{ id: 'coder', prompt: 'Implement' }] }] } })
  const candidate = { schemaVersion: 1, strategy, taskTypes: [],
    route: { models, tools: [], tdd: true, maxConcurrency: 1 },
    estimates: { wallTimeMs: null, quality: null, costMicrounits: null, currency: 'USD', source: 'demo forecast' } }
  const feedback = advanceFeedback(bank, { manifest: { schemaVersion: 1, experimentId: 'chat-demo',
    mode: 'frozen', splits: { train: [], validation: [], test: [request.taskId] } },
  cutoff: '2000-01-01T00:00:00.000Z', policy: { schemaVersion: 1, revision: 'chat-demo-v1',
    alpha: 0.2, lambda: 1, weights: { quality: 1, time: 0, cost: 0 },
    normalization: { wallTimeMs: 120000, costMicrounits: budgetMicrounits }, currency: 'USD',
    allowedModels: models, allowedTools: [], maxConcurrency: 1, maxWallTimeMs: 120000,
    maxCostMicrounits: budgetMicrounits, minQuality: null } })
  const route = prompt => [{ model: { provider: 'deepseek', model: 'deepseek-flash' },
    seconds: 3, costMicrounits: 301229, prompt }]
  const job = { schemaVersion: 1, request, baseSnapshot, bankDir, feedback, candidate, budgetMicrounits,
    evaluationDockerImage: values['docker-image'],
    resources: { agentSlots: 1, timeoutMs: 100000, maxArtifactBytes: 16000, maxInputBytes: 32000 },
    skills: { implement: route(request.description),
      refactor: route('Keep the verified source behavior. Return the source files with a distinct revision.') } }
  const path = join(directory, 'skill-job.json')
  await writeFile(path, JSON.stringify(job, null, 2), { mode: 0o600, flag: 'wx' })
  console.log(path)
} finally { bank.close() }
