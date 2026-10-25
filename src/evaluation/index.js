import { randomUUID } from 'node:crypto'
import { canonicalJson, jsonObject } from '../contracts/bank.js'
import { digest, runSuite, validateSnapshot, validateSpec } from './runner.js'

/** Independent evidence collector; reports cannot be supplied by the coding agent. */
export class TDDEvaluator {
  #spec
  #phases = []
  #busy = false
  #finalized = false
  #id = randomUUID()
  #bank
  #attemptId
  #baseRevision

  constructor({ spec, bank, attemptId }) {
    validateSpec(spec)
    this.#spec = JSON.parse(canonicalJson(spec))
    if (Boolean(bank) !== Boolean(attemptId)) throw new Error('bank and attemptId must be supplied together')
    if (bank) {
      const attempt = bank.getAttempt(attemptId)
      if (!attempt || attempt.state !== 'running') throw new Error('A running attempt is required')
      if (canonicalJson(attempt.request.testSpec) !== canonicalJson(this.#spec)) throw new Error('TestSpec must match the pinned bank request')
      bank.appendEvent(attemptId, 'evaluation-session', {
        kind: 'evaluation-session', payload: { evaluatorId: this.#id, specHash: digest(this.#spec) },
      })
      bank.attachArtifact(attemptId, 'evaluation-spec', bank.putArtifact(Buffer.from(canonicalJson(this.#spec))))
      this.#bank = bank; this.#attemptId = attemptId; this.#baseRevision = attempt.request.baseCommit
    }
  }

  async runPhase(phase, snapshot, options = {}) {
    if (!['baseline', 'red', 'green', 'refactor'].includes(phase)) throw new Error('Unknown TDD phase')
    if (this.#finalized) throw new Error('Evaluation is finalized')
    if (this.#busy) throw new Error('An evaluation phase is already running')
    if (this.#bank && this.#bank.getAttempt(this.#attemptId)?.state !== 'running') throw new Error('Attempt is terminal')
    validateSnapshot(snapshot)
    const pinned = JSON.parse(canonicalJson(snapshot))
    const seen = name => this.#phases.some(p => p.phase === name)
    if ((phase === 'baseline' && this.#phases.length)
      || (phase === 'red' && ['red', 'green', 'refactor'].some(seen))
      || (phase === 'green' && seen('refactor'))
      || (phase === 'refactor' && !seen('green'))) throw new Error('Invalid phase order')
    if (['baseline', 'red'].includes(phase) && this.#baseRevision && pinned.revision !== this.#baseRevision) {
      throw new Error('Baseline revision must match the pinned baseCommit')
    }
    const baseline = this.#phases.find(p => p.phase === 'baseline')
    if (phase === 'red' && baseline && baseline.snapshotHash !== digest(pinned)) {
      throw new Error('RED must run on the baseline snapshot')
    }
    const testPaths = new Set(this.#spec.suites.flatMap(s => Object.keys(s.files)))
    if (Object.keys(pinned.files).some(p => testPaths.has(p))) throw new Error('Snapshot cannot replace pinned test files')
    this.#busy = true
    const record = { phase, sequence: this.#phases.length + 1, snapshotHash: digest(pinned),
      revision: pinned.revision, reports: [] }
    try {
      const suites = this.#spec.suites.filter(s => phase === 'baseline' ? s.kind === 'regression'
        : phase === 'red' ? s.kind === 'target' : true)
      for (const suite of suites) {
        const report = await runSuite(this.#spec, suite, pinned, options)
        record.reports.push(report)
        if (this.#bank) {
          const ref = this.#bank.putArtifact(Buffer.from(canonicalJson(report)))
          const name = `evaluation-report/${this.#phases.length + 1}/${suite.id}`
          this.#bank.attachArtifact(this.#attemptId, name, ref)
          this.#bank.appendEvent(this.#attemptId, name, { kind: 'evaluation-report',
            payload: { phase, suiteId: suite.id, artifact: ref } })
        }
      }
      this.#phases.push(record)
      if (this.#bank) this.#bank.appendEvent(this.#attemptId, `evaluation-phase/${record.sequence}`, {
        kind: 'evaluation-phase', payload: record,
      })
      return structuredClone(record)
    } catch (error) {
      record.error = error.message
      if (!this.#phases.includes(record)) this.#phases.push(record)
      throw error
    } finally { this.#busy = false }
  }

  evaluate() {
    if (this.#busy) throw new Error('An evaluation phase is already running')
    const latest = name => this.#phases.findLast(p => p.phase === name)
    const baseline = latest('baseline'), red = latest('red'), green = latest('green'), refactor = latest('refactor')
    const final = refactor ?? green
    const requiredTests = this.#spec.suites.map(suite => {
      const report = final?.reports.find(r => r.suiteId === suite.id)
      return { id: suite.id, status: ['passed', 'failed'].includes(report?.status) ? report.status : 'error' }
    })
    const allPassed = phase => Boolean(phase && !phase.error && phase.reports.length && phase.reports.every(r => r.status === 'passed'))
    const failed = phase => phase?.reports.some(r => r.status === 'failed')
    const correctness = requiredTests.some(t => t.status === 'failed') ? 'failed'
      : allPassed(final) && requiredTests.every(t => t.status === 'passed') ? 'passed' : 'inconclusive'
    let redMatched = Boolean(red && !red.error && red.reports.length === this.#spec.suites.filter(s => s.kind === 'target').length)
    let invalidRed = false
    for (const report of red?.reports ?? []) {
      const expected = this.#spec.suites.find(s => s.id === report.suiteId).expectedRedTests
      const failures = report.tests.filter(t => t.type === 'test:fail' && !t.skip && !t.todo)
      const matches = report.status === 'failed' && failures.every(t => t.code === 'ERR_ASSERTION')
        && canonicalJson(failures.map(t => t.name).sort()) === canonicalJson([...expected].sort())
      redMatched &&= matches
      if (report.status === 'passed' || (report.status === 'failed' && !matches)) invalidRed = true
    }
    let tddCompliance = 'inconclusive'
    if (failed(baseline) || invalidRed || failed(green) || failed(refactor)) tddCompliance = 'failed'
    else if (allPassed(baseline) && redMatched && allPassed(green) && allPassed(refactor)) tddCompliance = 'passed'
    const status = correctness === 'failed' || tddCompliance === 'failed' ? 'failed'
      : correctness === 'passed' && tddCompliance === 'passed' ? 'success' : 'inconclusive'
    const reasons = []
    if (!allPassed(baseline)) reasons.push('Baseline regression evidence is missing or not passed')
    if (!redMatched) reasons.push('Expected RED assertion failures were not independently established')
    if (!allPassed(green)) reasons.push('GREEN evidence is missing or not passed')
    if (!allPassed(refactor)) reasons.push('REFACTOR evidence is missing or not passed')
    return { schemaVersion: 2, status, requiredTests, correctness, tddCompliance,
      evidence: { specHash: digest(this.#spec), finalSnapshotHash: final?.snapshotHash ?? null,
        finalRevision: final?.revision ?? null, reasons, phases: structuredClone(this.#phases) },
      provenance: { source: 'independent-node-evaluator', revision: 'v1', evaluatorId: this.#id } }
  }

  finalize(outcome) {
    if (this.#finalized) throw new Error('Evaluation is finalized')
    jsonObject(outcome, 'outcome')
    jsonObject(outcome.measured, 'outcome.measured'); jsonObject(outcome.estimates, 'outcome.estimates')
    const result = this.evaluate()
    if (this.#bank) {
      this.#bank.attachArtifact(this.#attemptId, 'evaluation-result', this.#bank.putArtifact(Buffer.from(canonicalJson(result))))
      this.#bank.finalizeAttempt(this.#attemptId, result, outcome)
    }
    this.#finalized = true
    return result
  }
}
