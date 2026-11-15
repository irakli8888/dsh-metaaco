import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { mkdir, writeFile, appendFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify, parseArgs } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { StrategyBank } from '../src/bank/index.js'
import { runDag } from '../src/execution/index.js'
import { validateMetaacoDag } from '../src/planning/index.js'
import { createTextRuntime } from './offline-runtime.js'

const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent'))
const { LlmAdapter } = await import(require.resolve('@deepseek-ai/dsh-llm'))

// This adapter has no network implementation and never reads credentials.
export async function runSchedulingReplay({ directory, seeds = [7, 11, 42], delayUnitMs = 1000 }) {
  if (!Number.isSafeInteger(delayUnitMs) || delayUnitMs < 1 || delayUnitMs > 2000) throw new Error('Invalid delay unit')
  if (!Array.isArray(seeds) || !seeds.length || seeds.length > 10 || new Set(seeds).size !== seeds.length || seeds.some(s => !Number.isSafeInteger(s))) throw new Error('Invalid seeds')
  await mkdir(directory, { recursive: true })
  const ids = ['review', 'docs', 'patch', 'tests'], durations = [4, 4, 1, 10]
  const plan = { version: 3, execution: 'dag', name: 'scheduling-replay', description: 'Synthetic delays through real Harness',
    resources: { agentSlots: 2, maxArtifactBytes: 1024, maxInputBytes: 4096, timeoutMs: 60000 },
    tasks: ids.map(id => ({ id, prompt: id, dependsOn: id === 'tests' ? ['patch'] : [],
      inputs: id === 'tests' ? [{ name: 'patch', taskId: 'patch' }] : [], slots: 1,
      model: { provider: 'replay', model: 'fixture' } })) }
  const problem = { version: 2, plan, durationEstimatesSeconds: Object.fromEntries(ids.map((id, i) => [id, durations[i]])) }
  const manifest = { schemaVersion: 1, kind: 'synthetic-delay-replay', seeds, delayUnitMs, problem,
    nodeVersion: process.version, ordering: 'alternating paired modes', quality: 'inconclusive',
    limitation: 'Timer fixtures, not real LLM latency or coding quality; estimates use logical seconds.' }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' })
  const input = join(directory, 'problem.json')
  await writeFile(input, JSON.stringify(problem), { flag: 'wx' })
  const bank = new StrategyBank({ dataDir: join(directory, 'bank') }), runs = []
  try {
    const strategy = bank.register({ schemaVersion: 1, strategyId: 'scheduling-replay', version: 1, provenance: {},
      workflow: { name: 'replay', description: 'offline timers', stages: [{ title: 'fixture', agents: [{ id: 'fixture', prompt: 'fixture' }] }] } })
    for (const [index, seed] of seeds.entries()) for (const mode of index % 2 ? ['metaaco', 'fixed'] : ['fixed', 'metaaco']) {
      const attemptId = `${seed}-${mode}`, timeline = []
      let active = 0, maxActive = 0, artifactsVerified = 0, runtime
      bank.beginAttempt({ attemptId, strategy, selection: { seed, mode }, request: { schemaVersion: 1,
        taskId: 'branching-fixture', description: manifest.limitation, repo: 'fixture', baseCommit: 'fixture-v1', testSpec: {}, provenance: {} } })
      const start = performance.now()
      try {
        let selected = plan, planning = null
        if (mode === 'metaaco') {
          const { stdout } = await promisify(execFile)(process.env.METAACO_PYTHON || 'python3', ['-B',
            fileURLToPath(new URL('../python/metaaco_dag.py', import.meta.url)), '--problem', input, '--seed', String(seed)], { timeout: 15000 })
          planning = validateMetaacoDag(JSON.parse(stdout), problem); selected = planning.plan
          bank.attachArtifact(attemptId, 'planning', bank.putArtifact(Buffer.from(JSON.stringify(planning))))
        }
        const planningWallTimeMs = performance.now() - start
        runtime = await createTextRuntime({ provider: 'replay', guardAdapter: adapter => adapter,
          promptFor: envelope => JSON.stringify(envelope), createAdapter: () => ({ quote: () => { throw new Error('No billing in replay') }, adapter: new class extends LlmAdapter {
            async *stream(options) {
              const envelope = JSON.parse(options.system), taskId = envelope.task
              assert.ok(ids.includes(taskId))
              if (taskId === 'tests') assert.equal(envelope.artifacts[0]?.content, 'artifact:patch')
              active++; maxActive = Math.max(maxActive, active)
              timeline.push({ type: 'start', taskId, atMs: performance.now() - start })
              try {
                await delay(problem.durationEstimatesSeconds[taskId] * delayUnitMs, undefined, { signal: options.signal })
                yield { type: 'block-end', index: 0, block: { type: 'text', text: `artifact:${taskId}` } }
                yield { type: 'finish', reason: { kind: 'stop' } }
              } finally { active--; timeline.push({ type: 'finish', taskId, atMs: performance.now() - start }) }
            }
          }() }) })
        const execution = await runDag(runtime.ctx, runtime.parent, selected, { bank, attemptId, allowLlm: true,
          subagentProvider: runtime.subagentProvider, verifyArtifact: ({ taskId, artifact }) => {
            assert.equal(bank.getArtifact(artifact).toString(), `artifact:${taskId}`); artifactsVerified++
          } })
        await runtime.dispose(); runtime = null
        const measured = { planningWallTimeMs, executionWallTimeMs: execution.wallTimeMs, totalWallTimeMs: performance.now() - start }
        const row = { seed, mode, measured, execution, maxActive, artifactsVerified, timeline, planning }
        bank.finalizeAttempt(attemptId, { status: 'inconclusive', requiredTests: [], provenance: { reason: manifest.limitation } }, { measured, estimates: planning?.estimates ?? {} })
        await appendFile(join(directory, 'runs.jsonl'), JSON.stringify(row) + '\n')
        runs.push(row)
      } catch (error) {
        await appendFile(join(directory, 'runs.jsonl'), JSON.stringify({ seed, mode, error: error.message, execution: error.report ?? null, timeline }) + '\n')
        if (bank.getAttempt(attemptId).state === 'running') bank.recoverInterrupted([attemptId], error.message)
        throw error
      } finally { await runtime?.dispose() }
    }
    const report = { ...manifest, runs }
    await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' })
    return report
  } finally { bank.close() }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } })
  if (!values.out) throw new Error('Usage: node examples/scheduling-replay.js --out /new/directory')
  const report = await runSchedulingReplay({ directory: resolve(values.out) })
  console.table(report.runs.map(r => ({ seed: r.seed, mode: r.mode, ...r.measured })))
}
