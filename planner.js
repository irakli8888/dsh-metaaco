import { validateWorkflow, runWorkflow } from './index.js'

/** Versioned, data-only boundary. This module never launches Python or a model. */
export function validatePlan(plan) {
  if (!plan || Array.isArray(plan) || typeof plan !== 'object'
    || Object.keys(plan).some(key => !['version', 'planner', 'execution', 'workflow'].includes(key))
    || plan.version !== 1 || plan.planner !== 'python-metaaco'
    || plan.execution !== 'serial-order') {
    throw new Error('Expected Python MetaACO plan v1 with serial-order execution')
  }
  const { workflow, count } = validateWorkflow(plan.workflow)
  if (workflow.stages.some(stage => stage.agents.length !== 1)) {
    throw new Error('serial-order requires exactly one child per stage')
  }
  // Snapshot before asynchronous execution so callers cannot mutate a validated plan.
  return { workflow: structuredClone(workflow), count }
}

export async function runPlannedWorkflow(ctx, parent, plan, { allowLlm = false, ...options } = {}) {
  const { workflow } = validatePlan(plan)
  if (allowLlm !== true) throw new Error('Explicit allowLlm: true is required for execution')
  return runWorkflow(ctx, parent, workflow, options)
}
