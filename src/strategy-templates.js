import { analyzeTask } from './analyzer/index.js'
import { validateDag } from './execution/contracts.js'

const skills = {
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

/** Compile an offline variant problem v1. Estimates and model routing are supplied by the caller. */
export function compileStrategies(request, { hints, resources, model, estimates, budgetMicrounits }) {
  if (!Number.isSafeInteger(budgetMicrounits) || budgetMicrounits < 0) throw new Error('Invalid budget')
  const analysis = analyzeTask(request, { hints })
  const context = JSON.stringify({
    description: request.description, stack: analysis.stack.value, requirements: analysis.requirements,
  })
  const variants = templates.filter(template => template.types.includes(analysis.classification.type.value))
    .map(template => {
      let costMicrounits = 0
      const durationEstimatesSeconds = {}
      const tasks = Object.entries(template.steps).map(([id, dependsOn]) => {
        const forecast = estimates?.[id]
        if (!Number.isSafeInteger(forecast?.seconds) || forecast.seconds < 1 ||
            !Number.isSafeInteger(forecast.costMicrounits) || forecast.costMicrounits < 0) {
          throw new Error(`Missing or invalid forecast for ${id}`)
        }
        costMicrounits += forecast.costMicrounits
        durationEstimatesSeconds[id] = forecast.seconds
        return { id, prompt: `${skills[id]}\nTask context: ${context}`, dependsOn,
          inputs: dependsOn.map(taskId => ({ name: taskId, taskId })), slots: 1, model }
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
