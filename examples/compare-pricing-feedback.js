import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { StrategyBank } from '../src/bank/index.js'
import { advanceFeedback, readFeedback, selectWithFeedback } from '../src/feedback/index.js'
import { templateStudyTasks } from './template-study-tasks.js'
import { compileStrategies } from '../src/strategy-templates.js'

const [bankPath, summaryPath] = process.argv.slice(2)
if (!bankPath || !summaryPath) throw new Error('Supply a study bank and its summary.json')
const task = templateStudyTasks().find(({ request }) => request.taskId === 'event-range')
const summary = JSON.parse(readFileSync(summaryPath, 'utf8'))
const bank = new StrategyBank({ dataDir: bankPath })
try {
  const { revision, snapshot } = readFeedback(bank, summary.feedback)
  assert.equal(snapshot.records.length, 2)
  assert.equal(revision.summary.verifiedSuccesses, 2)
  const policy = revision.policy
  const stored = bank.getAttempt('direct-v1').selection.selector.candidates
  const spec = compileStrategies(task.request, {
    hints: { type: 'feature' }, model: { provider: 'deepseek', model: 'deepseek-flash' },
    resources: { agentSlots: 2, maxArtifactBytes: 24000, maxInputBytes: 48000, timeoutMs: 130000 },
    budgetMicrounits: policy.maxCostMicrounits, tdd: true,
    estimates: Object.fromEntries(['design', 'implement', 'write-tests', 'integrate', 'refactor']
      .map(step => [step, { seconds: 3, costMicrounits: 301229 }])),
  })
  const candidates = spec.variants.map(variant => {
    const candidate = stored.find(item => item.strategy.strategyId === variant.id)
    assert.ok(candidate)
    return { ...candidate, estimates: { ...candidate.estimates,
      wallTimeMs: Object.values(variant.problem.durationEstimatesSeconds).reduce((a, b) => a + b, 0) * 1000,
      costMicrounits: variant.costMicrounits, source: 'held-out conservative serial forecast',
    } }
  })
  const decide = (policy, train) => {
    const feedback = advanceFeedback(bank, { policy, cutoff: revision.cutoff, manifest: {
      schemaVersion: 1, experimentId: 'pricing-transfer-v1', mode: 'frozen',
      splits: { train, validation: [], test: [task.request.taskId] },
    } })
    const decision = selectWithFeedback(bank, feedback, { request: task.request, candidates })
    return { feedback, selected: decision.selected?.strategy, scores: decision.scores, training: decision.training }
  }
  const compare = weights => {
    const selectedPolicy = { ...policy, weights }
    return { weights, empty: decide(selectedPolicy, []),
      trained: decide(selectedPolicy, revision.manifest.splits.train) }
  }
  const accounting = snapshot.records.map(({ attemptId, outcome }) => ({
    attemptId, wallTimeMs: outcome.measured.wallTimeMs, coverageComplete: outcome.measured.coverageComplete,
    pricingComplete: outcome.calculated.pricingComplete, costs: outcome.calculated.costs,
  }))
  console.log(JSON.stringify({ taskId: task.request.taskId, accounting,
    weighted: compare({ quality: 0.6, time: 0.25, cost: 0.15 }),
    qualityAndTime: compare({ quality: 0.6, time: 0.4, cost: 0 }),
  }, null, 2))
} finally { bank.close() }
