import { createHash } from 'node:crypto'
import { canonicalJson } from './contracts/bank.js'
import { analyzeTask } from './analyzer/index.js'
import { validateDag } from './execution/contracts.js'

const skills = {
  refactor: 'Refactor the verified implementation while preserving behavior. Return a full snapshot with a new revision.',
  design: 'Define component boundaries and interface contracts. Return the contracts.',
  implement: 'Implement the requested change using any supplied contracts. Return changed files.',
  'write-tests': 'Draft tests for the requirements and supplied contracts. Return test files.',
  integrate: 'Combine the supplied implementation and test files. Return the integrated files.',
}

const templates = [
  { id: 'direct-v1', types: ['feature', 'bugfix', 'refactor'], steps: { implement: [] } },
  { id: 'contract-v1', types: ['feature'], steps: {
    design: [], implement: ['design'], 'write-tests': ['design'], integrate: ['implement', 'write-tests'],
  } },
]

// Optional skills add artifact dependencies around the required implementation.
function composeVariants(type, model, modelChoices, tdd) {
  const result = []
  for (const design of type === 'feature' ? [false, true] : [false]) {
    for (const tests of [false, true]) {
      const inputs = design ? ['design'] : []
      const steps = {
        ...(design ? { design: [] } : {}),
        implement: inputs,
        ...(tests ? { 'write-tests': inputs, integrate: ['implement', 'write-tests'] } : {}),
      }
      let routes = [{}]
      for (const skill of [...Object.keys(steps), ...(tdd ? ['refactor'] : [])]) {
        const choices = modelChoices[skill] ?? [model]
        if (!Array.isArray(choices) || !choices.length || routes.length * choices.length + result.length > 16) {
          throw new Error('Expected at most 16 composed graph and model variants')
        }
        routes = routes.flatMap(route => choices.map(choice => ({ ...route, [skill]: choice })))
      }
      for (const route of routes) {
        const digest = createHash('sha256').update(canonicalJson({ steps, route })).digest('hex')
        const id = `composed-${digest.slice(0, 32)}`
        if (result.some(item => item.id === id)) throw new Error('Duplicate composed variant')
        result.push({ id, steps, route })
      }
    }
  }
  return result
}

/** Compile an offline variant problem v1. Estimates and model routing are supplied by the caller. */
export function compileStrategies(request, { hints, resources, model, estimates, budgetMicrounits, tdd = false, compose = false, modelChoices = {} }) {
  if (!Number.isSafeInteger(budgetMicrounits) || budgetMicrounits < 0) throw new Error('Invalid budget')
  const analysis = analyzeTask(request, { hints })
  const context = JSON.stringify({
    description: request.description, stack: analysis.stack.value, requirements: analysis.requirements,
  })
  const type = analysis.classification.type.value
  const applicable = templates.filter(template => template.types.includes(type))
  const patterns = compose && applicable.length ? composeVariants(type, model, modelChoices, tdd) : applicable
  const variants = patterns.map(template => {
      let costMicrounits = 0
      const durationEstimatesSeconds = {}
      const steps = tdd ? { ...template.steps, refactor: [Object.keys(template.steps).at(-1)] } : template.steps
      const tasks = Object.entries(steps).map(([id, dependsOn]) => {
        const assigned = template.route ? template.route[id] : model
        const forecast = estimates?.[id]?.byModel?.[`${assigned?.provider}/${assigned?.model}`] ?? estimates?.[id]
        if (!Number.isSafeInteger(forecast?.seconds) || forecast.seconds < 1 ||
            !Number.isSafeInteger(forecast.costMicrounits) || forecast.costMicrounits < 0) {
          throw new Error(`Missing or invalid forecast for ${id}`)
        }
        costMicrounits += forecast.costMicrounits
        durationEstimatesSeconds[id] = forecast.seconds
        return { id, prompt: `${skills[id]}${tdd && [Object.keys(template.steps).at(-1), "refactor"].includes(id) ? " Return JSON with revision and full files." : ""}\nTask context: ${context}`, dependsOn,
          inputs: dependsOn.map(taskId => ({ name: taskId, taskId })), slots: 1, model: assigned }
      })
      if (!Number.isSafeInteger(costMicrounits) ||
          Object.values(durationEstimatesSeconds).reduce((a, b) => a + b, 0) > 86400) {
        throw new Error('Template forecast exceeds planner limits')
      }
      const plan = validateDag({ version: 3, execution: 'dag', name: template.id,
        description: request.description, resources, tasks })
      return { id: template.id, costMicrounits, problem: { version: 2, plan, durationEstimatesSeconds } }
    })
  if (!variants.length) throw new Error('No template for the analyzed task type')
  return { schemaVersion: 1, variants, requiredTasks: ['implement'], budgetMicrounits }
}
