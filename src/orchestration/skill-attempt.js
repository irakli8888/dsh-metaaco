import { routeQualityEvidence } from './route-quality.js'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { validateDag } from '../execution/contracts.js'
import { readFeedback } from '../feedback/index.js'
import { armId } from '../selector/contracts.js'
import { runAdaptiveAttempt } from './index.js'

const planner = fileURLToPath(new URL('../../python/skill_decisions.py', import.meta.url))

export async function runSkillAttempt({ skills, resources, budgetMicrounits, requiredSkills = [], candidate,
  exploreTraining = false, ...attempt }) {
  if (attempt.allowLlm !== true) throw new Error('Explicit allowLlm: true is required')
  const { revision: { policy, manifest }, snapshot } = readFeedback(attempt.bank, attempt.feedback)
  if (typeof exploreTraining !== 'boolean') throw new Error('Expected boolean exploreTraining')
  if (exploreTraining && (manifest.mode !== 'online-train' || !manifest.splits.train.includes(attempt.request.taskId))) {
    throw new Error('Route exploration requires an online-train manifest and a training task')
  }
  const allowed = new Set(candidate.route.models.filter(model => policy.allowedModels.includes(model)))
  const catalog = Object.fromEntries(Object.entries(skills).map(([id, routes]) => [id, routes.filter(
    ({ model }) => model && allowed.has(`${model.provider}/${model.model}`))]))
  const qualityEvidence = routeQualityEvidence(attempt.bank, snapshot, attempt.request)
  const trainingEvidence = exploreTraining
    ? routeQualityEvidence(attempt.bank, snapshot, attempt.request, { sameTask: true })
    : []
  const dir = await mkdtemp(join(tmpdir(), 'metaaco-skills-'))
  let selection
  try {
    const path = join(dir, 'skills.json')
    await writeFile(path, JSON.stringify({ skills: catalog, resources, requiredSkills, qualityEvidence, trainingEvidence, exploreTraining,
      budgetMicrounits: Math.min(budgetMicrounits, policy.maxCostMicrounits ?? Infinity) }), { mode: 0o600 })
    const { stdout } = await promisify(execFile)('python3', ['-B', planner, path],
      { timeout: 30000, signal: attempt.signal })
    selection = JSON.parse(stdout)
    selection.qualitySnapshotId = snapshot.snapshotId
    selection.qualityRoutesObserved = qualityEvidence.length
    selection.modelAlternatives = Object.fromEntries(Object.entries(catalog).map(([skill, routes]) =>
      [skill, routes.map(({ model, seconds, costMicrounits }, index) =>
        ({ id: `${skill}/${index}`, model, seconds, costMicrounits }))]))
  } finally { await rm(dir, { recursive: true, force: true }) }
  const original = validateDag(selection.problem.plan)
  const tasks = new Map(original.tasks.map(task => [task.id, task]))
  if (selection.dispatchOrder.length !== tasks.size || new Set(selection.dispatchOrder).size !== tasks.size ||
      selection.dispatchOrder.some(id => !tasks.has(id))) throw new Error('Invalid skill dispatch order')
  const plan = validateDag({ ...original, tasks: selection.dispatchOrder.map(id => tasks.get(id)) })
  const routed = { ...candidate, estimates: { ...candidate.estimates,
    wallTimeMs: selection.makespanSeconds * 1000, costMicrounits: selection.estimatedCostMicrounits,
    source: 'MetaACO skill search forecast' } }
  const binding = { schemaVersion: 1, armId: armId(routed), plan,
    greenTaskId: plan.tasks.find(task => task.id === 'refactor').dependsOn[0], refactorTaskId: 'refactor' }
  const result = await runAdaptiveAttempt({ ...attempt, candidates: [routed], bindings: [binding],
    componentTaskIds: plan.tasks.filter(task => task.id.startsWith('implement-')).map(task => task.id),
    templateSelection: selection })
  return { ...result, skillSelection: selection }
}
