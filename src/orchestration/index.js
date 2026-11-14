import { fields, canonicalJson, validateRequest } from '../contracts/bank.js'
import { clone, hash, armId } from '../selector/contracts.js'
import { readFeedback, selectWithFeedback, advanceFeedback } from '../feedback/index.js'
import { MetricsCollector, BudgetController } from '../metrics/index.js'
import { createBudgetedAdapter } from '../adapters/harness/budget.js'
import { validateDag, runDag } from '../execution/index.js'
import { TDDEvaluator } from '../evaluation/index.js'
import { validateSpec, validateSnapshot } from '../evaluation/runner.js'
import { analyzeTask } from '../analyzer/index.js'
import { validateMetaacoDag, runMetaacoDag } from '../planning/index.js'

function bindingFor(bindings, selected) {
  const matches = bindings.filter(b => b.armId === selected.armId)
  if (matches.length !== 1) throw new Error('Exactly one binding for selected route is required')
  const b = clone(matches[0])
  fields(b, ['schemaVersion', 'armId', 'plan', 'greenTaskId', 'refactorTaskId'], 'Execution binding')
  if (b.schemaVersion !== 1) throw new Error('Unsupported binding')
  b.plan = validateDag(b.plan)
  if (b.plan.resources.agentSlots > selected.route.maxConcurrency) throw new Error('Plan concurrency exceeds selected route')
  for (const task of b.plan.tasks) {
    if (!task.model || !selected.route.models.includes(`${task.model.provider}/${task.model.model}`)) throw new Error('Plan model differs from selected route')
  }
  const green = b.plan.tasks.find(t => t.id === b.greenTaskId), refactor = b.plan.tasks.find(t => t.id === b.refactorTaskId)
  if (!green || !refactor || green.id === refactor.id || !refactor.dependsOn.includes(green.id)
    || !refactor.inputs.some(i => i.taskId === green.id)) throw new Error('REFACTOR must depend on and consume GREEN')
  if (!selected.route.tdd) throw new Error('Adaptive TDD execution requires a TDD route')
  return b
}
function passed(record) { return record.reports.length > 0 && record.reports.every(r => r.status === 'passed') }
function redPassed(record, spec) {
  return record.reports.length > 0 && record.reports.every(r => {
    const expected = spec.suites.find(s => s.id === r.suiteId).expectedRedTests
    const failures = r.tests.filter(t => t.type === 'test:fail' && !t.skip && !t.todo)
    return r.status === 'failed' && failures.every(t => t.code === 'ERR_ASSERTION')
      && canonicalJson(failures.map(t => t.name).sort()) === canonicalJson([...expected].sort())
  })
}

/** Trusted application composition. createRuntime must install only the supplied guarded adapters. */
export async function runAdaptiveAttempt({ bank, attemptId, request: input, feedback, candidates, bindings,
  baseSnapshot: baseInput, createRuntime, planning = null, selectionMethod, evaluationDockerImage, allowLlm = false, signal }) {
  if (allowLlm !== true) throw new Error('Explicit allowLlm: true is required')
  signal?.throwIfAborted()
  if (typeof createRuntime !== 'function') throw new Error('A trusted runtime factory is required')
  const request = clone(input), base = clone(baseInput)
  feedback = clone(feedback)
  planning = planning === null ? null : clone(planning)
  validateRequest(request); validateSpec(request.testSpec); validateSnapshot(base)
  if (base.revision !== request.baseCommit) throw new Error('Base snapshot revision mismatch')
  const { revision } = readFeedback(bank, feedback)
  const selectedAt = new Date().toISOString()
  const decision = selectWithFeedback(bank, feedback, { request, candidates, selectedAt, method: selectionMethod })
  if (!decision.selected) throw new Error('No admissible strategy')
  const binding = bindingFor(bindings, decision.selected), policy = revision.policy
  const planned = planning === null ? null : validateMetaacoDag(planning.result, planning.problem)
  if (planned && canonicalJson(planning.problem.plan) !== canonicalJson(binding.plan)) throw new Error('Planner problem differs from selected binding')
  if (policy.maxWallTimeMs !== null && policy.maxWallTimeMs > 2147483647) throw new Error('Attempt deadline exceeds timer range')
  if (bank.getAttempt(attemptId)) throw new Error('Attempt already exists; replay forbidden')
  bank.beginAttempt({ attemptId, request, strategy: decision.selected.strategy,
    selection: { selector: decision, feedback, bindingHash: hash(binding) } })
  const chosen = decision.candidates.find(c => armId(c) === decision.selected.armId)
  const collector = new MetricsCollector({ bank, attemptId, estimates: chosen.estimates })
  const controller = new AbortController(), combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  let timedOut = false, runtime, evaluator, execution = null, error = null, timer
  if (policy.maxWallTimeMs !== null) timer = setTimeout(() => { timedOut = true; controller.abort(new Error('Attempt deadline exceeded')) }, Math.min(policy.maxWallTimeMs, 2147483647))
  const attach = (name, data) => bank.attachArtifact(attemptId, name, bank.putArtifact(Buffer.from(canonicalJson(data))))
  const phase = async (name, snapshot, phaseSignal = combined) => {
    collector.startSpan(name, 'test')
    try { return await evaluator.runPhase(name, snapshot, { signal: phaseSignal, dockerImage: evaluationDockerImage }) }
    finally { collector.endSpan(name, phaseSignal.aborted ? 'cancelled' : 'completed') }
  }
  try {
    attach('execution-binding', binding); attach('base-snapshot', base)
    collector.startSpan('analysis', 'analysis')
    attach('task-analysis', analyzeTask(request, { analyzedAt: selectedAt }))
    collector.endSpan('analysis', 'completed')
    evaluator = new TDDEvaluator({ bank, attemptId, spec: request.testSpec })
    const baseline = await phase('baseline', base)
    combined.throwIfAborted()
    if (!passed(baseline)) throw new Error('Baseline regression gate did not pass')
    const red = await phase('red', base)
    combined.throwIfAborted()
    if (!redPassed(red, request.testSpec)) throw new Error('Expected RED gate did not pass')
    const budget = policy.maxCostMicrounits === null ? null : new BudgetController({ bank,
      budgetId: `attempt/${attemptId}`, currency: policy.currency, limitMicrounits: policy.maxCostMicrounits })
    runtime = await createRuntime({ attemptId, signal: combined, plan: clone(binding.plan),
      guardAdapter: (adapter, quote) => createBudgetedAdapter(adapter, { collector, budget, attemptId, quote,
        models: decision.selected.route.models, tools: decision.selected.route.tools, allowLlm, signal: combined }) })
    combined.throwIfAborted()
    if (typeof runtime?.dispose !== 'function') throw new Error('Runtime must provide dispose()')
    const executionOptions = { bank, attemptId, allowLlm, signal: combined,
      subagentProvider: runtime.subagentProvider,
      verifyArtifact: async ({ taskId, artifact, signal: nodeSignal }) => {
        const name = taskId === binding.greenTaskId ? 'green' : taskId === binding.refactorTaskId ? 'refactor' : null
        if (!name) return
        const snapshot = JSON.parse(bank.getArtifact(artifact).toString('utf8'))
        validateSnapshot(snapshot)
        const record = await phase(name, snapshot, nodeSignal)
        if (!passed(record)) throw new Error(`Independent ${name.toUpperCase()} gate did not pass`)
      } }
    execution = planned
      ? await runMetaacoDag(runtime.ctx, runtime.parent, planned, planning.problem, executionOptions)
      : await runDag(runtime.ctx, runtime.parent, binding.plan, executionOptions)
  } catch (caught) { error = caught; execution = caught.report ?? execution }
  finally {
    try { await runtime?.dispose?.() } catch (caught) { error ??= caught }
    clearTimeout(timer)
  }
  const state = timedOut || combined.reason?.name === 'TimeoutError' || execution?.status === 'timeout' ? 'timeout' : combined.aborted ? 'cancelled' : error ? 'failed' : 'completed'
  collector.finish(state) // No claim of complete provider coverage from a caller-supplied deployment.
  const outcome = collector.snapshot()
  attach('attempt-metrics', outcome)
  if (error) bank.appendEvent(attemptId, 'orchestration-error', { kind: 'orchestration-error-v1', payload: { message: error.message, state } })
  if (state === 'timeout') bank.timeoutAttempt(attemptId, error?.message ?? 'Attempt deadline exceeded', outcome)
  else if (state === 'cancelled') bank.cancelAttempt(attemptId, error?.message ?? 'Attempt cancelled')
  else {
    const evaluation = evaluator?.evaluate()
    if (evaluation) attach('independent-evaluation', evaluation)
    // Execution/setup failure must never turn into success from a preceding passing phase.
    if (error && evaluation?.status !== 'failed') bank.finalizeAttempt(attemptId,
      { status: execution?.status === 'failed' ? 'failed' : 'inconclusive', requiredTests: [],
        provenance: { source: 'orchestration-v1', reason: error.message } }, outcome)
    else evaluator.finalize(outcome)
  }
  const attempt = bank.getAttempt(attemptId)
  let nextFeedback = feedback, feedbackError = null
  if (revision.manifest.mode === 'online-train' && revision.manifest.splits.train.includes(request.taskId)) {
    try {
      const cutoff = new Date(Math.max(Date.now(), Date.parse(attempt.finishedAt) + 1)).toISOString()
      nextFeedback = advanceFeedback(bank, { manifest: revision.manifest, policy, cutoff, previous: feedback })
    } catch (caught) { feedbackError = caught.message }
  }
  return { schemaVersion: 1, attempt, execution, feedback: nextFeedback, feedbackError }
}
