import { readFile, readdir, open, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { canonicalJson, text, validateRequest } from '../contracts/bank.js'
import { clone, hash, armId, compare } from '../selector/contracts.js'
import { seededIndex } from '../selector/index.js'
import { readFeedback, selectWithFeedback } from '../feedback/index.js'
import { validateSnapshot, validateSpec } from '../evaluation/runner.js'
import { validateDag } from '../execution/index.js'
import { validateMetaacoDag } from '../planning/index.js'
import { runAdaptiveAttempt } from '../orchestration/index.js'
import { MetricsCollector } from '../metrics/index.js'

export const EXPERIMENT_MODES = Object.freeze(['random', 'fixed', 'cheapest', 'historical-best', 'contextual-bandit', 'metaaco-without-bank', 'metaaco-with-bank'])
const exec = promisify(execFile), root = fileURLToPath(new URL('../../', import.meta.url))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
async function tree(directory, suffix, prefix = '') {
  const output = {}
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => compare(a.name, b.name))) {
    if (entry.isDirectory() && entry.name !== '__pycache__') Object.assign(output, await tree(join(directory, entry.name), suffix, `${prefix}${entry.name}/`))
    else if (entry.isFile() && entry.name.endsWith(suffix)) output[prefix + entry.name] = digest(await readFile(join(directory, entry.name)))
  }
  return output
}
async function solverFiles(source) {
  text(source, 'solverSource')
  const files = await tree(resolve(source, 'rcpsp'), '.py', 'rcpsp/')
  if (!files['rcpsp/core.py'] || !files['rcpsp/metaACO.py']) throw new Error('Real MetaACO source is required')
  return files
}
async function environment() {
  const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: root })
  return { projectCommit: stdout.trim(), node: process.version,
    lockfileSha256: digest(await readFile(join(root, 'pnpm-lock.yaml'))),
    packageSha256: digest(await readFile(join(root, 'package.json'))),
    sourceFiles: await tree(join(root, 'src'), '.js', 'src/'),
    pythonFiles: await tree(join(root, 'python'), '.py', 'python/') }
}
export function experimentMethod(mode, seed, fixedArmId) {
  if (!EXPERIMENT_MODES.includes(mode)) throw new Error('Unknown experiment mode')
  if (mode === 'random') return { kind: 'random', seed }
  if (['fixed', 'metaaco-without-bank'].includes(mode)) return { kind: 'fixed', armId: fixedArmId }
  return { kind: mode === 'metaaco-with-bank' ? 'contextual-bandit' : mode }
}
function cellsFor(tasks, seeds) {
  const cells = []
  for (const task of tasks) for (const seed of seeds) {
    const modes = [...EXPERIMENT_MODES]
    for (let i = modes.length - 1; i > 0; i--) {
      const j = seededIndex(seed, `${task.request.taskId}/${i}`, i + 1)
      ;[modes[i], modes[j]] = [modes[j], modes[i]]
    }
    cells.push(...modes.map(mode => ({ taskId: task.request.taskId, seed, mode })))
  }
  return cells
}

/** Seal a frozen held-out comparison before observing any evaluation outcomes. */
export async function prepareExperiment(bank, { experimentId, feedback, tasks, candidates, seeds, fixedArmId, runtimeConfig, solverSource }) {
  text(experimentId, 'experimentId'); text(fixedArmId, 'fixedArmId')
  const { revision } = readFeedback(bank, feedback)
  if (revision.manifest.mode !== 'frozen') throw new Error('Experiments require frozen feedback')
  if (revision.policy.maxWallTimeMs !== null && revision.policy.maxWallTimeMs > 2147483647) throw new Error('Deadline exceeds timer range')
  if (!Array.isArray(seeds) || seeds.length < 2 || seeds.length > 32 || new Set(seeds).size !== seeds.length) throw new Error('Require 2–32 unique uint32 seeds')
  seeds.forEach(seed => seededIndex(seed, 'validation', 1))
  if (!Array.isArray(tasks) || !tasks.length || tasks.length > 64) throw new Error('Require 1–64 held-out tasks')
  const ordered = clone(tasks).sort((a, b) => compare(a.request.taskId, b.request.taskId))
  if (new Set(ordered.map(t => t.request.taskId)).size !== ordered.length) throw new Error('Duplicate task IDs')
  const canonicalCandidates = clone(candidates).sort((a, b) => compare(armId(a), armId(b)))
  if (!canonicalCandidates.some(c => armId(c) === fixedArmId)) throw new Error('Fixed arm is absent')
  for (const task of ordered) {
    validateRequest(task.request); validateSpec(task.request.testSpec); validateSnapshot(task.baseSnapshot)
    if (task.baseSnapshot.revision !== task.request.baseCommit) throw new Error('Base revision mismatch')
    if (!revision.manifest.splits.test.includes(task.request.taskId)) throw new Error('Task must belong to held-out test split')
    if (!Array.isArray(task.bindings) || task.bindings.length !== canonicalCandidates.length) throw new Error('Bindings must cover every candidate')
    for (const c of canonicalCandidates) {
      const matches = task.bindings.filter(b => b.armId === armId(c))
      if (matches.length !== 1) throw new Error('Each candidate requires exactly one binding')
      const b = matches[0], plan = validateDag(b.plan), durations = task.durations?.[b.armId]
      if (b.schemaVersion !== 1 || !durations || Object.keys(durations).length !== plan.tasks.length
        || plan.tasks.some(t => !Number.isSafeInteger(durations[t.id]) || durations[t.id] <= 0)
        || Object.values(durations).reduce((a, b) => a + b, 0) > 86400) throw new Error('Invalid binding duration estimates')
      if (plan.resources.agentSlots > c.route.maxConcurrency || plan.tasks.some(t => !t.model || !c.route.models.includes(`${t.model.provider}/${t.model.model}`))) throw new Error('Binding route mismatch')
      const refactor = plan.tasks.find(t => t.id === b.refactorTaskId)
      if (!plan.tasks.some(t => t.id === b.greenTaskId) || !refactor?.dependsOn.includes(b.greenTaskId)
        || !refactor.inputs.some(i => i.taskId === b.greenTaskId)) throw new Error('Invalid TDD binding')
    }
    // Validate candidates and every selection contract while there is no dispatch permission.
    for (const mode of EXPERIMENT_MODES) selectWithFeedback(bank, feedback, { request: task.request,
      candidates: canonicalCandidates, method: experimentMethod(mode, seeds[0], fixedArmId) })
  }
  const payload = { schemaVersion: 1, experimentId, feedback: clone(feedback), tasks: ordered,
    candidates: canonicalCandidates, seeds: [...seeds].sort((a, b) => a - b), fixedArmId,
    runtimeConfig: clone(runtimeConfig), environment: await environment(), solverSourceFiles: await solverFiles(solverSource) }
  const manifest = { ...payload, cells: cellsFor(ordered, payload.seeds) }
  return bank.putArtifact(Buffer.from(canonicalJson({ ...manifest, manifestId: hash(manifest) })))
}

async function plan(problem, seed, source, expected, signal, python) {
  const dir = await mkdtemp(join(tmpdir(), 'metaaco-experiment-'))
  try {
    const path = join(dir, 'problem.json'); await writeFile(path, canonicalJson(problem), { mode: 0o600 })
    const { stdout } = await exec(python, ['-B', join(root, 'python/metaaco_dag.py'), '--source', source, '--problem', path, '--seed', String(seed)],
      { signal, timeout: 30000, maxBuffer: 4 * 1024 * 1024 })
    const result = validateMetaacoDag(JSON.parse(stdout), problem)
    for (const [path, sha] of Object.entries(result.provenance.sourceFiles)) if (expected[path] !== sha) throw new Error('Solver source changed')
    return { result, problem }
  } finally { await rm(dir, { recursive: true, force: true }) }
}
function percentile(values, fraction) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]
}
export function summarizeExperiment(rows, modes = EXPERIMENT_MODES) {
  return modes.map(mode => {
    const subset = rows.filter(r => r.mode === mode), states = {}
    for (const row of subset) states[row.state] = (states[row.state] ?? 0) + 1
    const successes = subset.filter(r => r.verifiedSuccess).length
    const time = subset.map(r => r.totalWallTimeMs).filter(v => v !== null)
    const costs = subset.map(r => r.costMicrounits)
    const totalCost = costs.length && costs.every(v => v !== null) ? costs.reduce((n, v) => n + v, 0) : null
    return { mode, count: subset.length, states, successes, successRate: subset.length ? successes / subset.length : null,
      medianWallTimeMs: percentile(time, 0.5), p95WallTimeMs: percentile(time, 0.95),
      minWallTimeMs: time.length ? Math.min(...time) : null, maxWallTimeMs: time.length ? Math.max(...time) : null,
      knownCostMicrounits: subset.reduce((n, r) => n + (r.knownCostMicrounits ?? 0), 0),
      unknownCostCount: costs.filter(v => v === null).length, totalCostMicrounits: totalCost,
      costPerSuccessMicrounits: totalCost === null || !successes ? null : totalCost / successes }
  })
}

/** Sequential, bounded frozen evaluation; append-only journal, never implicit paid retry/resume. */
export async function runExperiment(bank, ref, { journal, createRuntime, runtimeConfig, solverSource, python = 'python3', seriesBudget, evaluationDockerImage, allowLlm = false, signal } = {}) {
  if (allowLlm !== true) throw new Error('Explicit allowLlm: true required for experiment dispatch')
  signal?.throwIfAborted()
  if (typeof createRuntime !== 'function') throw new Error('Trusted runtime factory required')
  const manifest = JSON.parse(bank.getArtifact(ref)), { manifestId, ...payload } = manifest
  if (manifest.schemaVersion !== 1 || hash(payload) !== manifestId) throw new Error('Invalid experiment manifest')
  if (canonicalJson(runtimeConfig) !== canonicalJson(manifest.runtimeConfig)) throw new Error('Runtime configuration differs from pinned manifest')
  if (canonicalJson(await environment()) !== canonicalJson(manifest.environment)) throw new Error('Project environment changed; prepare a new manifest')
  if (canonicalJson(await solverFiles(solverSource)) !== canonicalJson(manifest.solverSourceFiles)) throw new Error('Solver source differs from manifest')
  const { revision } = readFeedback(bank, manifest.feedback)
  const ids = manifest.cells.map((_, i) => `experiment/${manifestId}/${i}`)
  if (ids.some(id => bank.getAttempt(id))) throw new Error('Experiment already dispatched; automatic replay forbidden')
  const file = await open(journal, 'wx', 0o600), rows = []
  const append = async value => { await file.writeFile(`${canonicalJson(value)}\n`); await file.sync() }
  const captureMetrics = row => {
    const metrics = new MetricsCollector({ bank, attemptId: row.attemptId }).snapshot()
    const cost = metrics.calculated.costs.find(c => c.currency === row.currency)
    row.knownCostMicrounits = cost?.knownMicrounits ?? 0
    row.costMicrounits = metrics.measured.coverageComplete && metrics.calculated.pricingComplete ? cost?.microunits ?? 0 : null
    row.metrics = bank.putArtifact(Buffer.from(canonicalJson(metrics)))
  }
  try {
    await append({ type: 'manifest', ref, manifestId, startedAt: new Date().toISOString() })
    for (const [index, cell] of manifest.cells.entries()) {
      const attemptId = ids[index], task = manifest.tasks.find(t => t.request.taskId === cell.taskId)
      const row = { ...cell, attemptId, state: 'not-run', verifiedSuccess: false, totalWallTimeMs: null,
        costMicrounits: null, knownCostMicrounits: null, currency: revision.policy.currency, reason: null }
      if (signal?.aborted) { row.reason = 'Experiment cancelled before dispatch'; rows.push(row); await append({ type: 'result', row }); continue }
      await append({ type: 'start', ...cell, attemptId })
      const started = performance.now()
      const controller = new AbortController()
      const cellSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
      const timer = revision.policy.maxWallTimeMs === null ? null : setTimeout(() => {
        controller.abort(new DOMException('Experiment cell deadline exceeded', 'TimeoutError'))
      }, revision.policy.maxWallTimeMs)
      try {
        const method = experimentMethod(cell.mode, cell.seed, manifest.fixedArmId)
        const selection = selectWithFeedback(bank, manifest.feedback, { request: task.request, candidates: manifest.candidates, method })
        if (!selection.selected) { row.state = 'inadmissible'; row.reason = 'No admissible strategy' }
        else {
          const binding = task.bindings.find(b => b.armId === selection.selected.armId)
          let planning = null
          if (cell.mode.startsWith('metaaco-')) planning = await plan({ version: 2, plan: binding.plan,
            durationEstimatesSeconds: task.durations[binding.armId] }, cell.seed, solverSource, manifest.solverSourceFiles, cellSignal, python)
          const result = await runAdaptiveAttempt({ bank, attemptId, request: task.request, baseSnapshot: task.baseSnapshot,
            feedback: manifest.feedback, candidates: manifest.candidates, bindings: task.bindings, selectionMethod: method, planning, seriesBudget, evaluationDockerImage,
            allowLlm, signal: cellSignal, createRuntime: args => createRuntime({ ...args, experimentCell: clone(cell), runtimeConfig: clone(manifest.runtimeConfig) }) })
          row.state = result.attempt.state
          const e = result.attempt.evaluation
          row.verifiedSuccess = result.attempt.state === 'succeeded' && e?.provenance?.source === 'independent-node-evaluator'
            && e.correctness === 'passed' && e.tddCompliance === 'passed'
          captureMetrics(row)
          row.selection = result.attempt.selection.selector.decisionId
        }
      } catch (error) {
        const attempt = bank.getAttempt(attemptId)
        row.state = attempt?.state === 'running' ? 'unresolved' : attempt?.state
          ?? (cellSignal.reason?.name === 'TimeoutError' ? 'timeout' : cellSignal.aborted ? 'cancelled' : 'error')
        row.reason = error.message
        if (attempt && bank.getEvents(attemptId).some(e => e.eventId === 'metrics/session')) {
          try { captureMetrics(row) } catch (metricsError) { row.reason += `; metrics unavailable: ${metricsError.message}` }
        }
      } finally { clearTimeout(timer) }
      row.totalWallTimeMs = performance.now() - started
      rows.push(row); await append({ type: 'result', row })
    }
    const summary = summarizeExperiment(rows)
    await append({ type: 'summary', summary, finishedAt: new Date().toISOString() })
    return { schemaVersion: 1, manifest: ref, rows, summary }
  } finally { await file.close() }
}
