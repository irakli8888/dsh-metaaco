import { applySnapshotPatch, applyTextEdits, claimComponentFiles } from './snapshot-patch.js'
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
  baseSnapshot: baseInput, createRuntime, planning = null, selectionMethod, planningByArm = null, templateSelection = null, editablePaths = null, textEdits = false, componentTaskIds = [], guardedCallsOnly = false, seriesBudget, evaluationDockerImage, allowLlm = false, signal }) {
  if (allowLlm !== true) throw new Error('Explicit allowLlm: true is required')
  signal?.throwIfAborted()
  if (typeof createRuntime !== 'function') throw new Error('A trusted runtime factory is required')
  const request = clone(input), base = clone(baseInput)
  feedback = clone(feedback)
  planning = planning === null ? null : clone(planning)
  editablePaths = editablePaths === null ? null : clone(editablePaths)
  if (editablePaths !== null && (!Array.isArray(editablePaths) || !editablePaths.length ||
      editablePaths.some(path => typeof path !== 'string' || !Object.hasOwn(base.files ?? {}, path)))) {
    throw new Error('Expected editable paths from the pinned snapshot')
  }
  if (textEdits && editablePaths === null) throw new Error('Text edits require editable paths')
  validateRequest(request); validateSpec(request.testSpec); validateSnapshot(base)
  if (base.revision !== request.baseCommit) throw new Error('Base snapshot revision mismatch')
  const { revision } = readFeedback(bank, feedback)
  const selectedAt = new Date().toISOString()
  const decision = selectWithFeedback(bank, feedback, { request, candidates, selectedAt, method: selectionMethod })
  if (!decision.selected) throw new Error('No admissible strategy')
  const binding = bindingFor(bindings, decision.selected), policy = revision.policy
  if (seriesBudget && (seriesBudget.currency !== policy.currency || !seriesBudget.budgetId?.startsWith('series/'))) {
    throw new Error('Series budget requires a series/ ID and the policy currency')
  }
  if (planningByArm !== null) {
    planning = clone(planningByArm[decision.selected.armId])
    templateSelection = { ...templateSelection, selectedId: planning.problem.plan.name }
  }
  const planned = planning === null ? null : validateMetaacoDag(planning.result, planning.problem)
  if (planned && canonicalJson(planning.problem.plan) !== canonicalJson(binding.plan)) throw new Error('Planner problem differs from selected binding')
  if (policy.maxWallTimeMs !== null && policy.maxWallTimeMs > 2147483647) throw new Error('Attempt deadline exceeds timer range')
  if (bank.getAttempt(attemptId)) throw new Error('Attempt already exists; replay forbidden')
  bank.beginAttempt({ attemptId, request, strategy: decision.selected.strategy,
    selection: { selector: decision, feedback, bindingHash: hash(binding) } })
  const chosen = decision.candidates.find(c => armId(c) === decision.selected.armId)
  const collector = new MetricsCollector({ bank, attemptId, estimates: chosen.estimates })
  const controller = new AbortController(), combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  let accountingLedgers = []
  const componentNodes = new Set(componentTaskIds)
  const componentOwners = new Map()
  let greenSnapshot = base
  let timedOut = false, runtime, evaluator, execution = null, error = null, timer
  if (policy.maxWallTimeMs !== null) timer = setTimeout(() => { timedOut = true; controller.abort(new Error('Attempt deadline exceeded')) }, Math.min(policy.maxWallTimeMs, 2147483647))
  const attach = (name, data) => bank.attachArtifact(attemptId, name, bank.putArtifact(Buffer.from(canonicalJson(data))))
  const phase = async (name, snapshot, phaseSignal = combined) => {
    collector.startSpan(name, 'test')
    try { return await evaluator.runPhase(name, snapshot, { signal: phaseSignal, dockerImage: evaluationDockerImage }) }
    finally { collector.endSpan(name, phaseSignal.aborted ? 'cancelled' : 'completed') }
  }
  try {
    if (templateSelection !== null) attach('template-selection', templateSelection)
    if (editablePaths !== null) attach('editable-paths', editablePaths)
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
    const shared = seriesBudget ? new BudgetController({ ...seriesBudget, bank }) : null
    // Reserve in both ledgers before dispatch. On an interrupted reservation the hold remains conservative.
    accountingLedgers = [budget, shared].filter(Boolean)
    const admission = shared && budget ? {
      snapshot: () => shared.snapshot(),
      reserve(input) { shared.reserve(input); return budget.reserve(input) },
      settle(input) {
        const local = budget.settle(input)
        const total = shared.settle(input)
        return { violated: total.violated || local.violated }
      },
    } : shared ?? budget
    runtime = await createRuntime({ attemptId, signal: combined, plan: clone(binding.plan),
      guardAdapter: (adapter, quote) => createBudgetedAdapter(adapter, { collector, budget: admission, attemptId, quote,
        models: decision.selected.route.models, tools: decision.selected.route.tools, allowLlm, signal: combined }) })
    combined.throwIfAborted()
    if (typeof runtime?.dispose !== 'function') throw new Error('Runtime must provide dispose()')
    const executionOptions = { bank, attemptId, allowLlm, signal: combined,
      subagentProvider: runtime.subagentProvider,
      verifyArtifact: async ({ taskId, artifact, signal: nodeSignal }) => {
        const name = taskId === binding.greenTaskId ? 'green' : taskId === binding.refactorTaskId ? 'refactor' : null
        if (!name && !componentNodes.has(taskId)) return
        const output = JSON.parse(bank.getArtifact(artifact).toString('utf8'))
        if (!name) {
          if (textEdits) applyTextEdits(base, output, editablePaths)
          else if (editablePaths === null) validateSnapshot(output)
          else applySnapshotPatch(base, output, editablePaths)
          claimComponentFiles(componentOwners, taskId, textEdits ? output.edits.map(edit => edit.path) : Object.keys(output.files))
          return
        }
        const snapshot = textEdits ? applyTextEdits(name === 'refactor' ? greenSnapshot : base, output, editablePaths)
          : editablePaths === null ? output : applySnapshotPatch(base, output, editablePaths)
        validateSnapshot(snapshot)
        const record = await phase(name, snapshot, nodeSignal)
        if (name === 'green') greenSnapshot = snapshot
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
  let coverageComplete = false
  if (guardedCallsOnly === true && state === 'completed' && accountingLedgers.length) {
    const calls = bank.getEvents(attemptId).filter(event => event.kind === 'metrics-v1' && event.payload.data.type === 'call')
      .map(event => event.payload.data.record)
    coverageComplete = calls.length > 0 && accountingLedgers.every(ledger => {
      const snapshot = ledger.snapshot()
      const reservations = snapshot.reservations.filter(row => row.attemptId === attemptId)
      return !snapshot.violated && reservations.length === calls.length && calls.every(call => {
        const reservation = reservations.find(row => row.reservationId === call.callId)
        return call.status === 'completed' && call.calculatedCost.currency === snapshot.currency
          && call.calculatedCost.microunits !== null
          && reservation?.settlement?.actualMicrounits === call.calculatedCost.microunits
      })
    })
  }
  collector.finish(state, { coverageComplete })
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
