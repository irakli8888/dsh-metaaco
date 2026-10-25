import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync, linkSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { migrations } from './migrations.js'
import { canonicalJson, jsonObject, fields, text, strategyRef, validateStrategy,
  validateRequest, validateEvaluation, artifactRef } from '../contracts/bank.js'

const now = () => new Date().toISOString()
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const parse = value => value === null ? null : JSON.parse(value)

/** Local persistent history. This API never executes a workflow, test or model. */
export class StrategyBank {
  #db
  #artifacts

  constructor({ dataDir }) {
    text(dataDir, 'dataDir')
    const root = resolve(dataDir)
    mkdirSync(root, { recursive: true, mode: 0o700 })
    this.#artifacts = join(root, 'artifacts')
    mkdirSync(this.#artifacts, { recursive: true, mode: 0o700 })
    this.#db = new DatabaseSync(join(root, 'bank.sqlite'))
    try {
      this.#db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;')
      this.#transaction(() => {
        const version = this.#db.prepare('PRAGMA user_version').get().user_version
        if (version > migrations.length) throw new Error('Database schema is newer than this Strategy Bank')
        for (let i = version; i < migrations.length; i++) {
          this.#db.exec(migrations[i])
          this.#db.exec(`PRAGMA user_version = ${i + 1}`)
        }
      })
    } catch (error) { this.close(); throw error }
  }

  #transaction(fn, readOnly = false) {
    this.#db.exec(readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE')
    try { const result = fn(); this.#db.exec('COMMIT'); return result }
    catch (error) { this.#db.exec('ROLLBACK'); throw error }
  }

  close() { if (this.#db) { this.#db.close(); this.#db = null } }

  register(strategy) {
    validateStrategy(strategy)
    const definition = canonicalJson(strategy)
    return this.#transaction(() => {
      const existing = this.#db.prepare('SELECT definition FROM strategies WHERE strategy_id=? AND version=?')
        .get(strategy.strategyId, strategy.version)
      if (existing && existing.definition !== definition) throw new Error('Strategy version is immutable')
      if (!existing) this.#db.prepare('INSERT INTO strategies VALUES (?,?,?,?)')
        .run(strategy.strategyId, strategy.version, definition, now())
      return { strategyId: strategy.strategyId, version: strategy.version }
    })
  }

  getStrategy(strategyId, version) {
    strategyRef({ strategyId, version })
    const row = this.#db.prepare('SELECT definition FROM strategies WHERE strategy_id=? AND version=?').get(strategyId, version)
    return row ? parse(row.definition) : null
  }

  listStrategies() {
    return this.#db.prepare('SELECT definition FROM strategies ORDER BY strategy_id, version').all().map(r => parse(r.definition))
  }

  beginAttempt(input) {
    fields(input, ['attemptId', 'request', 'strategy', 'selection'], 'Attempt input')
    text(input.attemptId, 'attemptId'); validateRequest(input.request); strategyRef(input.strategy)
    jsonObject(input.selection, 'selection')
    return this.#transaction(() => {
      if (!this.getStrategy(input.strategy.strategyId, input.strategy.version)) throw new Error('Unknown strategy version')
      const request = canonicalJson(input.request)
      const task = this.#db.prepare('SELECT request FROM tasks WHERE task_id=?').get(input.request.taskId)
      if (task && task.request !== request) throw new Error('Task request is immutable; use a new taskId for a new snapshot')
      const timestamp = now()
      if (!task) this.#db.prepare('INSERT INTO tasks VALUES (?,?,?)').run(input.request.taskId, request, timestamp)
      this.#db.prepare(`INSERT INTO attempts
        (attempt_id,task_id,strategy_id,strategy_version,selection,state,started_at) VALUES (?,?,?,?,?,'running',?)`)
        .run(input.attemptId, input.request.taskId, input.strategy.strategyId, input.strategy.version,
          canonicalJson(input.selection), timestamp)
      return input.attemptId
    })
  }

  getAttempt(attemptId) {
    text(attemptId, 'attemptId')
    const row = this.#db.prepare(`SELECT a.*, t.request FROM attempts a JOIN tasks t USING(task_id) WHERE attempt_id=?`).get(attemptId)
    if (!row) return null
    return { schemaVersion: 1, attemptId: row.attempt_id, request: parse(row.request),
      strategy: { strategyId: row.strategy_id, version: row.strategy_version }, selection: parse(row.selection),
      state: row.state, startedAt: row.started_at, finishedAt: row.finished_at,
      evaluation: parse(row.evaluation), outcome: parse(row.outcome), reason: row.reason }
  }

  listAttempts(filters = {}) {
    jsonObject(filters, 'filters')
    const names = { taskId: 'task_id', strategyId: 'strategy_id', state: 'state' }
    const clauses = [], args = []
    for (const [key, value] of Object.entries(filters)) {
      if (!Object.hasOwn(names, key)) throw new Error(`Unsupported attempt filter: ${key}`)
      text(value, key); clauses.push(`${names[key]}=?`); args.push(value)
    }
    return this.#transaction(() => this.#db.prepare(`SELECT attempt_id FROM attempts
      ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''} ORDER BY attempt_id`).all(...args)
      .map(r => this.getAttempt(r.attempt_id)), true)
  }

  #requireAttempt(attemptId) {
    const attempt = this.getAttempt(attemptId)
    if (!attempt) throw new Error(`Unknown attempt: ${attemptId}`)
    return attempt
  }

  appendEvent(attemptId, eventId, event) {
    text(eventId, 'eventId'); fields(event, ['kind', 'payload'], 'Event')
    text(event.kind, 'kind'); jsonObject(event.payload, 'payload')
    const encoded = canonicalJson(event)
    return this.#transaction(() => {
      const attempt = this.#requireAttempt(attemptId)
      const existing = this.#db.prepare('SELECT * FROM events WHERE attempt_id=? AND event_id=?').get(attemptId, eventId)
      if (existing) {
        if (existing.event !== encoded) throw new Error('Event id conflict')
        return this.#event(existing)
      }
      if (attempt.state !== 'running') throw new Error('Attempt is terminal')
      const sequence = this.#db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM events WHERE attempt_id=?').get(attemptId).next
      this.#db.prepare('INSERT INTO events VALUES (?,?,?,?,?)').run(attemptId, eventId, sequence, now(), encoded)
      return this.#event(this.#db.prepare('SELECT * FROM events WHERE attempt_id=? AND event_id=?').get(attemptId, eventId))
    })
  }

  #event(row) {
    return { schemaVersion: 1, attemptId: row.attempt_id, eventId: row.event_id,
      sequence: row.sequence, recordedAt: row.recorded_at, ...parse(row.event) }
  }

  getEvents(attemptId) {
    this.#requireAttempt(attemptId)
    return this.#db.prepare('SELECT * FROM events WHERE attempt_id=? ORDER BY sequence').all(attemptId).map(r => this.#event(r))
  }

  finalizeAttempt(attemptId, evaluation, outcome) {
    validateEvaluation(evaluation)
    jsonObject(outcome, 'outcome')
    jsonObject(outcome.measured, 'outcome.measured'); jsonObject(outcome.estimates, 'outcome.estimates')
    return this.#transaction(() => {
      const attempt = this.#requireAttempt(attemptId)
      const state = { success: 'succeeded', failed: 'failed', inconclusive: 'inconclusive' }[evaluation.status]
      if (attempt.state !== 'running') {
        if (attempt.state === state && canonicalJson(attempt.evaluation) === canonicalJson(evaluation)
          && canonicalJson(attempt.outcome) === canonicalJson(outcome)) return attempt
        throw new Error('Attempt is terminal')
      }
      this.#db.prepare('UPDATE attempts SET state=?,finished_at=?,evaluation=?,outcome=? WHERE attempt_id=?')
        .run(state, now(), canonicalJson(evaluation), canonicalJson(outcome), attemptId)
      return this.getAttempt(attemptId)
    })
  }

  cancelAttempt(attemptId, reason) { return this.#stop([attemptId], 'cancelled', reason) }

  /** Only call for IDs whose owner is known to have stopped; never auto-recover on open. */
  recoverInterrupted(attemptIds, reason) { return this.#stop(attemptIds, 'interrupted', reason) }

  #stop(attemptIds, state, reason) {
    text(reason, 'reason')
    if (!Array.isArray(attemptIds) || !attemptIds.length || new Set(attemptIds).size !== attemptIds.length) {
      throw new Error('Expected nonempty unique attemptIds')
    }
    return this.#transaction(() => {
      for (const id of attemptIds) {
        const attempt = this.#requireAttempt(id)
        if (attempt.state === state && attempt.reason === reason) continue
        if (attempt.state !== 'running') throw new Error('Attempt is terminal')
        this.#db.prepare('UPDATE attempts SET state=?,finished_at=?,reason=? WHERE attempt_id=?').run(state, now(), reason, id)
      }
      return attemptIds.map(id => this.getAttempt(id))
    })
  }

  putArtifact(bytes) {
    if (!(bytes instanceof Uint8Array)) throw new Error('Artifact requires Uint8Array bytes')
    const content = Buffer.from(bytes)
    const ref = { sha256: hash(content), sizeBytes: content.length }
    const path = join(this.#artifacts, ref.sha256)
    const temporary = join(this.#artifacts, `.tmp-${randomUUID()}`)
    try {
      writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 })
      const fd = openSync(temporary, 'r')
      try { fsyncSync(fd) } finally { closeSync(fd) }
      try { linkSync(temporary, path) } catch (error) { if (error.code !== 'EEXIST') throw error }
      this.getArtifact(ref)
      const dir = openSync(this.#artifacts, 'r')
      try { fsyncSync(dir) } finally { closeSync(dir) }
      this.#db.prepare('INSERT OR IGNORE INTO artifacts VALUES (?,?)').run(ref.sha256, ref.sizeBytes)
      return ref
    } finally {
      try { unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }

  getArtifact(ref) {
    artifactRef(ref)
    const bytes = readFileSync(join(this.#artifacts, ref.sha256))
    if (bytes.length !== ref.sizeBytes || hash(bytes) !== ref.sha256) throw new Error('Artifact integrity check failed')
    return bytes
  }

  attachArtifact(attemptId, name, ref) {
    text(name, 'artifact name'); artifactRef(ref)
    this.getArtifact(ref)
    return this.#transaction(() => {
      const attempt = this.#requireAttempt(attemptId)
      const stored = this.#db.prepare('SELECT * FROM artifacts WHERE sha256=?').get(ref.sha256)
      if (!stored || stored.size_bytes !== ref.sizeBytes) throw new Error('Unknown artifact reference')
      const existing = this.#db.prepare('SELECT sha256 FROM attempt_artifacts WHERE attempt_id=? AND name=?').get(attemptId, name)
      if (existing) {
        if (existing.sha256 !== ref.sha256) throw new Error('Artifact binding is immutable')
        return
      }
      if (attempt.state !== 'running') throw new Error('Attempt is terminal')
      this.#db.prepare('INSERT INTO attempt_artifacts VALUES (?,?,?)').run(attemptId, name, ref.sha256)
    })
  }

  /** Stable order from one consistent DB snapshot. Artifact bytes remain external. */
  exportJsonl() {
    return this.#transaction(() => {
      const records = []
      const add = (type, value) => records.push(canonicalJson({ schemaVersion: 1, type, value }))
      for (const row of this.#db.prepare('SELECT * FROM strategies ORDER BY strategy_id,version').all()) {
        add('strategy', { definition: parse(row.definition), createdAt: row.created_at })
      }
      for (const row of this.#db.prepare('SELECT * FROM tasks ORDER BY task_id').all()) {
        add('task', { request: parse(row.request), createdAt: row.created_at })
      }
      for (const row of this.#db.prepare('SELECT attempt_id FROM attempts ORDER BY attempt_id').all()) {
        add('attempt', this.getAttempt(row.attempt_id))
        for (const event of this.getEvents(row.attempt_id)) add('event', event)
      }
      for (const row of this.#db.prepare('SELECT * FROM artifacts ORDER BY sha256').all()) {
        add('artifact', { sha256: row.sha256, sizeBytes: row.size_bytes })
      }
      for (const row of this.#db.prepare('SELECT * FROM attempt_artifacts ORDER BY attempt_id,name').all()) {
        add('attemptArtifact', { attemptId: row.attempt_id, name: row.name, sha256: row.sha256 })
      }
      return records.length ? records.join('\n') + '\n' : ''
    }, true)
  }
}
