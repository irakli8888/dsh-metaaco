import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { join, dirname, sep } from 'node:path'

const parse = value => value === null ? null : JSON.parse(value)
const MAX_BYTES = 2 * 1024 * 1024
function bounded(path) {
  if (statSync(path).size > MAX_BYTES) throw new Error('Artifact exceeds 2 MiB viewer limit')
  return readFileSync(path)
}
/** No StrategyBank constructor, migrations, workflow dispatch or network calls. */
export function readInspection(directories) {
  const runs = [], sources = []
  for (const directory of directories) {
    const root = realpathSync(directory), db = new DatabaseSync(join(root, 'bank.sqlite'), { readOnly: true })
    let manifest = null
    for (const path of [join(root, 'manifest.json'), join(dirname(root), 'manifest.json')]) {
      try { manifest = JSON.parse(bounded(path)); break } catch { /* Legacy pilots need not have a sidecar manifest. */ }
    }
    const source = sources.length
    sources.push({ directory: root, manifest })
    try {
      db.exec('BEGIN')
      for (const row of db.prepare('SELECT * FROM attempts ORDER BY started_at,attempt_id').all()) {
        const artifacts = db.prepare('SELECT aa.name,a.sha256,a.size_bytes FROM attempt_artifacts aa JOIN artifacts a USING(sha256) WHERE aa.attempt_id=? ORDER BY aa.name').all(row.attempt_id).map(ref => {
          try {
            if (!/^[a-f0-9]{64}$/.test(ref.sha256)) throw new Error('Invalid artifact hash')
            const path = realpathSync(join(root, 'artifacts', ref.sha256))
            if (!path.startsWith(realpathSync(join(root, 'artifacts')) + sep)) throw new Error('Artifact escapes store')
            const bytes = bounded(path)
            if (bytes.length !== ref.size_bytes || createHash('sha256').update(bytes).digest('hex') !== ref.sha256) throw new Error('Artifact integrity mismatch')
            return { ...ref, text: bytes.toString('utf8'), error: null }
          } catch (error) { return { ...ref, text: null, error: error.message } }
        })
        const events = db.prepare('SELECT * FROM events WHERE attempt_id=? ORDER BY sequence').all(row.attempt_id)
          .map(e => ({ id: e.event_id, sequence: e.sequence, recordedAt: e.recorded_at, ...parse(e.event) }))
        runs.push({ id: row.attempt_id, source, state: row.state, startedAt: row.started_at, finishedAt: row.finished_at,
          selection: parse(row.selection), evaluation: parse(row.evaluation), outcome: parse(row.outcome), reason: row.reason,
          request: parse(db.prepare('SELECT request FROM tasks WHERE task_id=?').get(row.task_id).request),
          artifacts, events, traceAvailable: false })
      }
      db.exec('COMMIT')
    } finally { db.close() }
  }
  return { schemaVersion: 1, capturedAt: new Date().toISOString(), sources, runs }
}
export function renderInspection(data) {
  const template = readFileSync(new URL('./viewer.html', import.meta.url), 'utf8')
  const payload = JSON.stringify(data).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026')
  return template.replace('/*INSPECTION_DATA*/', () => payload)
}
