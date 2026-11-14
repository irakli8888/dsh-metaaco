import { fileURLToPath } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { parseArgs } from 'node:util'
import { StrategyBank } from '../src/bank/index.js'
import { prepareExperiment, runExperiment } from '../src/experiments/index.js'
import { offlineExperimentConfig } from './offline-experiment-config.js'
import { createOfflineRuntime } from './offline-runtime.js'
const { values } = parseArgs({ options: { source: { type: 'string' }, out: { type: 'string' } } })
const solverSource = values.source ?? process.env.METAACO_SOURCE ?? fileURLToPath(new URL('../python/vendor/', import.meta.url))
if (!values.out) throw new Error('Usage: pnpm experiment:offline --source /path/to/metaACOwithCodex --out /new/output/directory')
const directory = resolve(values.out)
await mkdir(directory, { recursive: true })
const bank = new StrategyBank({ dataDir: join(directory, 'bank') })
try {
  const config = offlineExperimentConfig(bank)
  const ref = await prepareExperiment(bank, { ...config, solverSource })
  await writeFile(join(directory, 'manifest-ref.json'), JSON.stringify(ref, null, 2), { flag: 'wx', mode: 0o600 })
  console.log('Offline fixtures only: 2 tasks × 2 seeds × 7 modes; no API requests.')
  const result = await runExperiment(bank, ref, { journal: join(directory, 'runs.jsonl'), runtimeConfig: config.runtimeConfig,
    solverSource, createRuntime: createOfflineRuntime, allowLlm: true })
  await writeFile(join(directory, 'report.json'), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 })
  console.table(result.summary.map(r => ({ mode: r.mode, runs: r.count, successes: r.successes, medianMs: Math.round(r.medianWallTimeMs), fullCost: r.totalCostMicrounits })))
  console.log('Synthetic fixtures test the protocol; they do not demonstrate superiority or API savings.')
} finally { bank.close() }
