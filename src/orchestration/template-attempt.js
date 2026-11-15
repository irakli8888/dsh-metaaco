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
    const { stdout } = await execute('python3', ['-B', planner, '--problem', path],
      { timeout: 30000, signal: attempt.signal, maxBuffer: 4 * 1024 * 1024 })
    selected = JSON.parse(stdout)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  const variant = spec.variants.find(item => item.id === selected.selectedId)
  const registered = Object.hasOwn(templateCandidates, variant.id) && templateCandidates[variant.id]
  if (!registered) throw new Error('Selected template lacks a registered strategy')
  const candidate = { ...registered, estimates: { ...registered.estimates,
    wallTimeMs: selected.schedule.estimates.scheduleMakespan * 1000,
    costMicrounits: variant.costMicrounits, source: 'template forecast and MetaACO schedule',
  } }
  const binding = { schemaVersion: 1, armId: armId(candidate), plan: variant.problem.plan,
    greenTaskId: variant.id === 'contract-v1' ? 'integrate' : 'implement', refactorTaskId: 'refactor' }
  const result = await runAdaptiveAttempt({ ...attempt, candidates: [candidate], bindings: [binding],
    templateSelection: selected, planning: { problem: variant.problem, result: selected.schedule } })
  return { ...result, variantSelection: selected }
}
