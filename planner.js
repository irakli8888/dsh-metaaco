import { validateWorkflow, runWorkflow } from './index.js'

const object = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const positiveInteger = value => Number.isSafeInteger(value) && value > 0

/** Versioned, data-only boundary. This module never launches Python or a model. */
export function validatePlan(plan) {
  const v2 = plan?.version === 2
  if (!object(plan, ['version', 'planner', 'execution', 'workflow', ...(v2 ? ['resources', 'estimates'] : [])])
    || ![1, 2].includes(plan.version) || plan.planner !== 'python-metaaco'
    || !['serial-order', 'start-groups'].includes(plan.execution)) {
    throw new Error('Expected Python MetaACO plan v1 or v2 with serial-order or start-groups execution')
  }
  const { workflow, count } = validateWorkflow(plan.workflow)
  if (plan.execution === 'serial-order' && workflow.stages.some(stage => stage.agents.length !== 1)) {
    throw new Error('serial-order requires exactly one child per stage')
  }
  if (v2) {
    if (!object(plan.resources, ['agentSlots']) || !positiveInteger(plan.resources.agentSlots)) {
      throw new Error('Plan resources require positive integer agentSlots')
    }
    if (workflow.stages.some(stage => stage.agents.length > plan.resources.agentSlots)) {
      throw new Error('Stage exceeds agentSlots capacity')
    }
    if (!object(plan.estimates, ['objective', 'durationUnit', 'scheduleMakespan', 'executionMakespan'])
      || plan.estimates.objective !== 'makespan' || plan.estimates.durationUnit !== 'seconds'
      || !positiveInteger(plan.estimates.scheduleMakespan) || !positiveInteger(plan.estimates.executionMakespan)) {
      throw new Error('Plan estimates require makespan objective and positive integer durations in seconds')
    }
  }
  // Snapshot before asynchronous execution so callers cannot mutate a validated plan.
  return { workflow: structuredClone(workflow), count,
    ...(v2 ? { resources: structuredClone(plan.resources), estimates: structuredClone(plan.estimates) } : {}) }
}

export async function runPlannedWorkflow(ctx, parent, plan, { allowLlm = false, ...options } = {}) {
  const { workflow } = validatePlan(plan)
  if (allowLlm !== true) throw new Error('Explicit allowLlm: true is required for execution')
  return runWorkflow(ctx, parent, workflow, options)
}
