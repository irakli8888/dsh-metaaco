import { parseArgs } from 'node:util'
import { writeFileSync } from 'node:fs'
import { readInspection, renderInspection } from '../src/inspector/index.js'
const { values } = parseArgs({ options: { bank: { type: 'string', multiple: true }, out: { type: 'string' } } })
if (!values.bank?.length || !values.out) throw new Error('Usage: node examples/inspect-runs.js --bank /data/bank --bank /other/bank --out /new/private/report.html')
const data = readInspection(values.bank)
writeFileSync(values.out, renderInspection(data), { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify({ runs: data.runs.length, sources: data.sources.length, capturedAt: data.capturedAt }))
