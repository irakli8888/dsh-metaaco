import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { compileStrategies } from '../strategy-templates.js'
import { armId } from '../selector/contracts.js'
import { readFeedback } from '../feedback/index.js'
import { runAdaptiveAttempt } from './index.js'

const execute = promisify(execFile)
const planner = fileURLToPath(new URL('../../python/metaaco_variants.py', import.meta.url))

export async function runTemplateAttempt({ templateOptions, templateCandidates, ...attempt }) {
  if (attempt.allowLlm !== true) throw new Error('Explicit allowLlm: true is required')
  const { revision: { policy } } = readFeedback(attempt.bank, attempt.feedback)
  const spec = compileStrategies(attempt.request, {
    ...templateOptions, tdd: true,
    budgetMicrounits: Math.min(templateOptions.budgetMicrounits, policy.maxCostMicrounits ?? Infinity),
  })
  spec.variants = spec.variants.filter(({ id, problem }) => {
    if (!Object.hasOwn(templateCandidates, id)) return false
    const { route } = templateCandidates[id]
    return route.tdd && problem.plan.resources.agentSlots <= Math.min(route.maxConcurrency, policy.maxConcurrency)
      && problem.plan.tasks.every(({ model }) => model && route.models.includes(`${model.provider}/${model.model}`)
        && policy.allowedModels.includes(`${model.provider}/${model.model}`))
  })
  if (!spec.variants.length) throw new Error('No registered template matches the execution policy')
  const dir = await mkdtemp(join(tmpdir(), 'metaaco-templates-'))
  let selected
  try {
    const path = join(dir, 'variants.json')
    await writeFile(path, JSON.stringify(spec), { mode: 0o600 })
    const { stdout } = await execute('python3', ['-B', planner, '--problem', path, '--include-schedules'],
      { timeout: 30000, signal: attempt.signal, maxBuffer: 4 * 1024 * 1024 })
    selected = JSON.parse(stdout)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  const candidates = [], bindings = [], planningByArm = Object.create(null)
  for (const row of selected.variants.filter(row => row.schedule)) {
    const variant = spec.variants.find(item => item.id === row.id)
    const registered = templateCandidates[row.id]
    const candidate = { ...registered, estimates: { ...registered.estimates,
      wallTimeMs: row.estimatedMakespanSeconds * 1000, costMicrounits: variant.costMicrounits,
      source: 'template forecast and MetaACO schedule',
    } }
    const id = armId(candidate)
    if (Object.hasOwn(planningByArm, id)) throw new Error('Templates require distinct strategy routes')
    candidates.push(candidate)
    bindings.push({ schemaVersion: 1, armId: id, plan: variant.problem.plan,
      greenTaskId: variant.id === 'contract-v1' ? 'integrate' : 'implement', refactorTaskId: 'refactor' })
    planningByArm[id] = { problem: variant.problem, result: row.schedule }
  }
  const comparison = { schemaVersion: 1, fastestId: selected.selectedId,
    variants: selected.variants.map(({ schedule, ...row }) => row) }
  const result = await runAdaptiveAttempt({ ...attempt, candidates, bindings, planningByArm,
    templateSelection: comparison })
  return { ...result, variantSelection: { ...comparison, selectedId: result.attempt.selection.selector.selected
    ? planningByArm[result.attempt.selection.selector.selected.armId].problem.plan.name : null } }
}
