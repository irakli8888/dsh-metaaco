import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, writeFile, appendFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify, parseArgs } from 'node:util'
import { StrategyBank } from '../src/bank/index.js'
import { MetricsCollector, BudgetController } from '../src/metrics/index.js'
import { createBudgetedAdapter } from '../src/adapters/harness/budget.js'
import { createDeepSeekAdapter } from '../src/adapters/harness/deepseek.js'
import { createTextRuntime } from './offline-runtime.js'
import { runDag } from '../src/execution/index.js'
import { validateMetaacoDag } from '../src/planning/index.js'

// A latency probe with coding-related JSON artifacts, not a coding/TDD evaluation.
export async function runLiveScheduling({ directory, key, fetchImpl, execute, budgetMicrounits, seeds = [7, 11, 42] }) {
  if (execute !== true) throw new Error('Explicit consent required')
  if (!key?.trim() || !directory) throw new Error('Key and fresh directory required')
  if (!Number.isSafeInteger(budgetMicrounits) || budgetMicrounits < 602458 || budgetMicrounits > 800000) throw new Error('Budget must be between 602458 and 800000 microunits')
  if (!Array.isArray(seeds) || !seeds.length || seeds.length > 3 || new Set(seeds).size !== seeds.length || seeds.some(s => !Number.isSafeInteger(s))) throw new Error('Invalid seeds')
  await mkdir(directory, { mode: 0o700 })
  const definitions = [
    ['review', 'List three edge cases for a JavaScript function adding two finite numbers. Return findings: array of strings.'],
    ['docs', 'Document a JavaScript function adding two finite numbers. Return summary: string and examples: array of {a,b,result}.'],
    ['patch', 'Implement addition of two finite JavaScript numbers a and b. Return expression: string containing only the JavaScript expression.'],
    ['tests', 'Read the supplied patch artifact. Return cases: array of at least three {a,b,result} objects testing that expression. Include negatives and zero.'],
  ]
  const plan = { version: 3, execution: 'dag', name: 'live-scheduling', description: 'Real API latency probe; quality inconclusive',
    resources: { agentSlots: 2, maxArtifactBytes: 16384, maxInputBytes: 32768, timeoutMs: 100000 },
    tasks: definitions.map(([id, instruction]) => ({ id, prompt: JSON.stringify({ id, instruction }),
      dependsOn: id === 'tests' ? ['patch'] : [], inputs: id === 'tests' ? [{ name: 'patch', taskId: 'patch' }] : [],
      slots: 1, model: { provider: 'deepseek', model: 'deepseek-flash' } })) }
  const problem = { version: 2, plan, durationEstimatesSeconds: { review: 2, docs: 2, patch: 2, tests: 2 } }
  const manifest = { schemaVersion: 1, kind: 'live-api-latency-probe', problem, seeds, budgetMicrounits,
    nodeVersion: process.version, ordering: 'alternating paired modes',
    estimatesSource: 'Rounded prior pilot median; review/docs are proxies, frozen before execution',
    limitation: 'Schema checks only; no generated code execution, independent acceptance tests or TDD. Quality inconclusive. No learning from these runs.' }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' })
  const input = join(directory, 'problem.json')
  await writeFile(input, JSON.stringify(problem), { flag: 'wx' })
  const bank = new StrategyBank({ dataDir: join(directory, 'bank') }), runs = []
  try {
    const budget = new BudgetController({ bank, budgetId: 'series/live-scheduling', currency: 'USD', limitMicrounits: budgetMicrounits })
    const strategy = bank.register({ schemaVersion: 1, strategyId: 'live-scheduling', version: 1, provenance: {},
      workflow: { name: 'probe', description: manifest.limitation, stages: [{ title: 'probe', agents: [{ id: 'probe', prompt: 'probe' }] }] } })
    for (const [index, seed] of seeds.entries()) for (const mode of index % 2 ? ['metaaco', 'fixed'] : ['fixed', 'metaaco']) {
      const attemptId = `${seed}-${mode}`
      bank.beginAttempt({ attemptId, strategy, selection: { seed, mode }, request: { schemaVersion: 1, taskId: 'addition-probe',
        description: manifest.limitation, repo: 'fixture', baseCommit: 'probe-v1', testSpec: {}, provenance: {} } })
      const collector = new MetricsCollector({ bank, attemptId }), start = performance.now()
      let runtime, execution = null, planning = null, error = null
      try {
        let selected = plan
        if (mode === 'metaaco') {
          const { stdout } = await promisify(execFile)(process.env.METAACO_PYTHON || 'python3', ['-B',
            fileURLToPath(new URL('../python/metaaco_dag.py', import.meta.url)), '--problem', input, '--seed', String(seed)], { timeout: 15000 })
          planning = validateMetaacoDag(JSON.parse(stdout), problem); selected = planning.plan
          bank.attachArtifact(attemptId, 'planning', bank.putArtifact(Buffer.from(JSON.stringify(planning))))
        }
        const planningWallTimeMs = performance.now() - start
        runtime = await createTextRuntime({ provider: 'deepseek', createAdapter: () => createDeepSeekAdapter({ key, fetchImpl }),
          guardAdapter: (adapter, quote) => createBudgetedAdapter(adapter, { quote, collector, budget, attemptId,
            models: ['deepseek/deepseek-flash'], allowLlm: true }),
          promptFor: envelope => 'Return only a JSON object. Include taskId matching the task id and the requested fields.\n' + JSON.stringify(envelope) })
        execution = await runDag(runtime.ctx, runtime.parent, selected, { bank, attemptId, allowLlm: true,
          subagentProvider: runtime.subagentProvider, verifyArtifact: ({ taskId, artifact }) => {
            const value = JSON.parse(bank.getArtifact(artifact).toString())
            assert.equal(value.taskId, taskId)
            if (taskId === 'patch') assert.ok(typeof value.expression === 'string' && value.expression.trim())
            if (taskId === 'review') assert.ok(Array.isArray(value.findings) && value.findings.length >= 3)
            if (taskId === 'docs') assert.ok(typeof value.summary === 'string' && Array.isArray(value.examples))
            if (taskId === 'tests') assert.ok(Array.isArray(value.cases) && value.cases.length >= 3)
          } })
        execution.planningWallTimeMs = planningWallTimeMs
      } catch (cause) { error = cause.message; execution = cause.report ?? execution }
      finally { await runtime?.dispose() }
      collector.finish(error ? 'failed' : 'completed', { coverageComplete: true })
      const metrics = collector.snapshot(), measured = { totalWallTimeMs: performance.now() - start,
        executionWallTimeMs: execution?.wallTimeMs ?? null, planningWallTimeMs: execution?.planningWallTimeMs ?? null }
      const row = { seed, mode, measured, execution, metrics, planning, error, budget: budget.snapshot() }
      bank.finalizeAttempt(attemptId, { status: 'inconclusive', requiredTests: [], provenance: { reason: manifest.limitation, error } },
        { measured, estimates: planning?.estimates ?? {} })
      await appendFile(join(directory, 'runs.jsonl'), JSON.stringify(row) + '\n')
      runs.push(row)
      if (error || row.budget.heldMicrounits || row.budget.violated) {
        await writeFile(join(directory, 'report.json'), JSON.stringify({ ...manifest, runs, budget: budget.snapshot(), stopped: true }, null, 2), { flag: 'wx' })
        throw new Error('Series stopped; inspect persisted report and budget before any new dispatch')
      }
    }
    const report = { ...manifest, runs, budget: budget.snapshot(), stopped: false }
    await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' })
    return report
  } finally { bank.close() }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, execute: { type: 'boolean' }, 'budget-microunits': { type: 'string' } } })
  const report = await runLiveScheduling({ directory: values.out && resolve(values.out), execute: values.execute,
    budgetMicrounits: Number(values['budget-microunits']), key: process.env.DEEPSEEK_API_KEY })
  console.log(JSON.stringify({ runs: report.runs.map(r => ({ mode: r.mode, seed: r.seed, ...r.measured })), budget: report.budget }, null, 2))
}
