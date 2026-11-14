import { createHash } from 'node:crypto'
import { fields, jsonObject, canonicalJson, text } from '../contracts/bank.js'
import { validateDag, runDag } from '../execution/index.js'

const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex')
const same = (a, b) => canonicalJson(a) === canonicalJson(b)
const parameters = { max_colonies: 10, max_evaluations: 100, replication_enabled: true,
  elite_enabled: true, local_search_enabled: true, selection: 'ucb', replication_mode: 'mutate',
  init_colonies: 3, iterations: 20, ants_per_iteration: 5, improvement_threshold: 0.02 }
function integer(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${label}`)
}
function sha(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid provenance SHA-256')
}

/** Independent feasibility check; provenance hashes identify sources, not an authenticity signature. */
export function validateMetaacoDag(result, problem) {
  fields(problem, ['version', 'plan', 'durationEstimatesSeconds'], 'DAG problem')
  if (problem.version !== 2) throw new Error('Expected DAG problem v2')
  const original = validateDag(problem.plan)
  const ids = original.tasks.map(t => t.id), byId = new Map(original.tasks.map(t => [t.id, t]))
  fields(problem.durationEstimatesSeconds, ids, 'duration estimates')
  let horizon = 0
  for (const duration of Object.values(problem.durationEstimatesSeconds)) {
    integer(duration, 'duration', 1); horizon += duration
  }
  integer(horizon, 'duration horizon', 1, 86400)
  fields(result, ['schemaVersion', 'planner', 'plan', 'estimates', 'measured', 'provenance'], 'MetaACO DAG result')
  if (result.schemaVersion !== 1 || result.planner !== 'python-metaaco-dag') throw new Error('Unsupported MetaACO DAG result')
  const plan = validateDag(result.plan)
  if (!same({ ...original, tasks: [] }, { ...plan, tasks: [] }) || plan.tasks.length !== ids.length
    || plan.tasks.some(t => !byId.has(t.id) || !same(t, byId.get(t.id)))) throw new Error('Solver changed the task contract')
  const e = result.estimates
  fields(e, ['durationUnit', 'scheduleMakespan', 'executionMakespan', 'reason', 'order', 'schedule'], 'schedule estimates')
  if (e.durationUnit !== 'seconds' || e.executionMakespan !== null) throw new Error('Execution time must remain unknown')
  text(e.reason, 'unknown execution time reason'); integer(e.scheduleMakespan, 'schedule makespan', 1)
  if (!Array.isArray(e.order) || e.order.length !== ids.length || new Set(e.order).size !== ids.length
    || e.order.some(id => !byId.has(id))) throw new Error('Invalid solver order')
  const positions = new Map(e.order.map((id, i) => [id, i]))
  if (original.tasks.some(t => t.dependsOn.some(dep => positions.get(dep) >= positions.get(t.id)))) throw new Error('Order violates precedence')
  if (!Array.isArray(e.schedule) || e.schedule.length !== ids.length) throw new Error('Incomplete schedule')
  const schedule = new Map(), events = new Map()
  let makespan = 0
  for (const row of e.schedule) {
    fields(row, ['taskId', 'startSeconds', 'durationSeconds'], 'Schedule row')
    if (!byId.has(row.taskId) || schedule.has(row.taskId)) throw new Error('Invalid schedule task')
    integer(row.startSeconds, 'start time'); integer(row.durationSeconds, 'duration', 1)
    if (row.durationSeconds !== problem.durationEstimatesSeconds[row.taskId]) throw new Error('Duration estimate changed')
    const end = row.startSeconds + row.durationSeconds
    integer(end, 'schedule end', 1); makespan = Math.max(makespan, end)
    schedule.set(row.taskId, row)
    const slots = byId.get(row.taskId).slots
    events.set(row.startSeconds, (events.get(row.startSeconds) ?? 0) + slots)
    events.set(end, (events.get(end) ?? 0) - slots)
  }
  if (makespan !== e.scheduleMakespan) throw new Error('Incorrect schedule makespan')
  for (const task of original.tasks) for (const dep of task.dependsOn) {
    const parent = schedule.get(dep)
    if (parent.startSeconds + parent.durationSeconds > schedule.get(task.id).startSeconds) throw new Error('Schedule violates precedence')
  }
  let used = 0
  for (const [, delta] of [...events].sort(([a], [b]) => a - b)) {
    used += delta
    if (used < 0 || used > original.resources.agentSlots) throw new Error('Schedule violates slot capacity')
  }
  const priority = [...e.order].sort((a, b) => schedule.get(a).startSeconds - schedule.get(b).startSeconds)
  if (!same(priority, plan.tasks.map(t => t.id))) throw new Error('DAG priority differs from solver projection')
  fields(result.measured, ['solverWallTimeMs', 'evaluations'], 'Solver measurements')
  if (!Number.isFinite(result.measured.solverWallTimeMs) || result.measured.solverWallTimeMs < 0) throw new Error('Invalid solver time')
  integer(result.measured.evaluations, 'evaluations', 1, 100)
  const p = result.provenance
  fields(p, ['seed', 'parameters', 'sourceFiles', 'bridgeSha256', 'pythonVersion', 'problemSha256'], 'Solver provenance')
  integer(p.seed, 'seed', -Number.MAX_SAFE_INTEGER); text(p.pythonVersion, 'pythonVersion')
  if (!same(p.parameters, parameters)) throw new Error('Unexpected MetaACO parameters')
  sha(p.bridgeSha256); sha(p.problemSha256)
  if (p.problemSha256 !== hash(problem)) throw new Error('Problem hash mismatch')
  jsonObject(p.sourceFiles, 'sourceFiles')
  if (!Object.hasOwn(p.sourceFiles, 'rcpsp/core.py') || !Object.hasOwn(p.sourceFiles, 'rcpsp/metaACO.py')) throw new Error('Incomplete solver manifest')
  for (const [path, digest] of Object.entries(p.sourceFiles)) {
    if (!/^rcpsp\/(?:[A-Za-z0-9_]+\/)*[A-Za-z0-9_]+\.py$/.test(path)) throw new Error('Invalid solver source path')
    sha(digest)
  }
  return JSON.parse(canonicalJson(result))
}

/** Persist planning evidence before the existing DAG executor gets permission to dispatch. */
export async function runMetaacoDag(ctx, parent, result, problem, options = {}) {
  const validated = validateMetaacoDag(result, problem)
  if (options.allowLlm !== true) throw new Error('Explicit allowLlm: true is required for execution')
  options.signal?.throwIfAborted()
  if (!parent) throw new Error('A live parent Agent is required')
  const { bank, attemptId } = options
  if (!bank || bank.getAttempt(attemptId)?.state !== 'running') throw new Error('A running Bank attempt is required')
  if (bank.getEvents(attemptId).some(e => e.eventId === 'dag/start')) throw new Error('DAG already started')
  const artifact = bank.putArtifact(Buffer.from(canonicalJson(validated)))
  bank.attachArtifact(attemptId, 'metaaco-dag-planning', artifact)
  bank.appendEvent(attemptId, 'metaaco-dag-planning', { kind: 'metaaco-dag-planning-v1', payload: { artifact } })
  return runDag(ctx, parent, validated.plan, options)
}
