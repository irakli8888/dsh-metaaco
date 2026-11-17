import { analyzeTask } from '../analyzer/index.js'
import { validateDag } from '../execution/contracts.js'

export function routeQualityEvidence(bank, snapshot, request) {
  const type = analyzeTask(request).classification.type.value
  if (type === null) return []
  const groups = new Map()
  for (const record of snapshot.records) {
    if (record.taskId === request.taskId || !record.evaluationVerified) continue
    const success = record.state === 'succeeded' && record.evaluation.status === 'success'
    const testFailure = record.state === 'failed' && record.evaluation.evidence?.phases?.some(phase =>
      ['green', 'refactor'].includes(phase.phase) && phase.reports?.some(report =>
        report.status === 'failed' && report.tests?.some(test => test.code === 'ERR_ASSERTION')))
    if (!success && !testFailure) continue
    const attempt = bank.getAttempt(record.attemptId)
    if (analyzeTask(attempt.request).classification.type.value !== type) continue
    const start = bank.getEvents(record.attemptId).find(event => event.kind === 'dag-start-v1')
    if (!start) continue
    const plan = validateDag(JSON.parse(bank.getArtifact(start.payload.planArtifact)))
    const route = plan.tasks.toSorted((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      .map(task => [task.id, task.model?.provider ?? null, task.model?.model ?? null, [...task.dependsOn].sort()])
    const key = JSON.stringify(route)
    const stats = groups.get(key) ?? { route, attempts: 0, successes: 0 }
    stats.attempts++
    if (success) stats.successes++
    groups.set(key, stats)
  }
  return [...groups.values()]
}
