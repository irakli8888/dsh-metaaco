import { canonicalJson, fields, text } from '../contracts/bank.js'

function integer(value, label, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${label}`)
}
function id(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) throw new Error('Expected kebab-case id (max 64 characters)')
}

export function validateDag(input) {
  fields(input, ['version', 'execution', 'name', 'description', 'resources', 'tasks'], 'DAG plan')
  if (input.version !== 3 || input.execution !== 'dag') throw new Error('Expected DAG plan v3')
  id(input.name); text(input.description, 'description')
  fields(input.resources, ['agentSlots', 'maxArtifactBytes', 'maxInputBytes', 'timeoutMs'], 'DAG resources')
  integer(input.resources.agentSlots, 'agentSlots', 256)
  integer(input.resources.maxArtifactBytes, 'maxArtifactBytes', 16 * 1024 * 1024)
  integer(input.resources.maxInputBytes, 'maxInputBytes', 16 * 1024 * 1024)
  integer(input.resources.timeoutMs, 'timeoutMs', 2147483647)
  if (!Array.isArray(input.tasks) || !input.tasks.length || input.tasks.length > 256) throw new Error('Expected 1–256 DAG tasks')
  const tasks = new Map()
  for (const task of input.tasks) {
    fields(task, ['id', 'prompt', 'dependsOn', 'inputs', 'slots', 'model'], 'DAG task')
    id(task.id); text(task.prompt, 'prompt')
    integer(task.slots, 'task slots', input.resources.agentSlots)
    if (tasks.has(task.id)) throw new Error('Duplicate task id')
    tasks.set(task.id, task)
    if (!Array.isArray(task.dependsOn) || new Set(task.dependsOn).size !== task.dependsOn.length) throw new Error('Invalid dependencies')
    if (!Array.isArray(task.inputs)) throw new Error('Invalid artifact inputs')
    const names = new Set()
    for (const binding of task.inputs) {
      fields(binding, ['name', 'taskId'], 'Artifact input'); id(binding.name); id(binding.taskId)
      if (names.has(binding.name)) throw new Error('Duplicate artifact input name')
      names.add(binding.name)
      if (!task.dependsOn.includes(binding.taskId)) throw new Error('Artifact producer must be a direct dependency')
    }
    if (task.model !== null) {
      fields(task.model, ['provider', 'model'], 'Model override')
      text(task.model.provider, 'model provider'); text(task.model.model, 'model')
    }
  }
  const visited = new Set(), visiting = new Set()
  const visit = task => {
    if (visiting.has(task.id)) throw new Error('DAG cycle detected')
    if (visited.has(task.id)) return
    visiting.add(task.id)
    for (const dep of task.dependsOn) {
      if (!tasks.has(dep)) throw new Error(`Unknown dependency: ${dep}`)
      visit(tasks.get(dep))
    }
    visiting.delete(task.id); visited.add(task.id)
  }
  for (const task of tasks.values()) visit(task)
  return JSON.parse(canonicalJson(input))
}
