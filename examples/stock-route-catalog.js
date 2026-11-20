import { stockComponentPrompts } from './stock-component-prompts.js'
import { templateStudyTasks } from './template-study-tasks.js'

export const task = templateStudyTasks().find(row => row.request.taskId === 'stock-reservation')
export const models = ['deepseek-flash', 'deepseek-v4-pro']
const production = task.request.description
export const prompts = {
  analyze: 'Return analysis.md with a short list of requirements and edge cases. ' + production,
  design: 'Return design.md with a short implementation plan. ' + production,
  implement: production,
  ...stockComponentPrompts,
  'write-tests': 'Return only test-plan.md with at most three one-line proposed test cases, under 60 words. Do not write test code. ' + production,
  integrate: 'Return the complete production snapshot, combining component files or preserving monolithic implementation. Exclude notes and tests. ' + production,
  review: 'Return review.md with at most three short findings about the implementation. ' + production,
  refactor: 'Return all production source files with a new revision. Preserve verified behavior. ' + production,
}
export const resources = { agentSlots: 2, timeoutMs: 80000, maxArtifactBytes: 16000, maxInputBytes: 32000 }
function* selections() {
  for (const analyze of [-1, 0, 1])
  for (const design of [-1, 0, 1])
  for (const review of [-1, 0, 1])
  for (const refactor of [0, 1])
  for (const writeTests of [-1, 0, 1]) {
    for (const implement of [0, 1])
    for (const integrate of writeTests === -1 ? [-1] : [0, 1])
      yield { analyze, design, review, refactor, 'write-tests': writeTests, implement, integrate }
    for (const stock of [0, 1])
    for (const reservation of [0, 1])
    for (const integrate of [0, 1])
      yield { analyze, design, review, refactor, 'write-tests': writeTests, 'implement-stock': stock, 'implement-reservation': reservation, integrate }
  }
}
function planFor(choices) {
  const tasks = []
  function add(id, dependsOn) {
    if (choices[id] === undefined || choices[id] < 0) return false
    tasks.push({ id, dependsOn, prompt: prompts[id], slots: 1, model: { provider: 'deepseek', model: models[choices[id]] },
      inputs: dependsOn.map(taskId => ({ name: taskId, taskId })) })
    return true
  }
  let context = []
  if (add('analyze', context)) context = ['analyze']
  if (add('design', context)) context = ['design']
  const implementation = ['implement', 'implement-stock', 'implement-reservation', 'write-tests'].filter(id => add(id, context))
  const green = add('integrate', implementation) ? 'integrate' : 'implement'
  const refactorParents = add('review', [green]) ? [green, 'review'] : [green]
  add('refactor', refactorParents)
  return { green, plan: { version: 3, execution: 'dag', name: 'stock-exhaustive', description: 'Fixed route', resources, tasks } }
}
export const catalog = [...selections()].map(planFor)
