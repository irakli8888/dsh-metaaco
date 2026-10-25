import { canonicalJson, fields, text } from '../contracts/bank.js'

function amount(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Money requires nonnegative safe integer microunits')
}
export function validateBilling(value) {
  fields(value, ['currency', 'microunits', 'source'], 'Billing')
  if (typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency)) throw new Error('Invalid billing currency')
  amount(value.microunits); text(value.source, 'billing source')
}
const now = () => new Date().toISOString()
const safe = value => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Accounting total exceeds safe integer range')
  return Number(value)
}

/** Used only through StrategyBank's transactions, never via a second SQLite owner. */
export class AccountingStore {
  constructor(db) { this.db = db }

  createBudget(definition) {
    fields(definition, ['budgetId', 'currency', 'limitMicrounits'], 'Budget')
    text(definition.budgetId, 'budgetId'); amount(definition.limitMicrounits)
    if (!/^[A-Z]{3}$/.test(definition.currency)) throw new Error('Invalid budget currency')
    const encoded = canonicalJson(definition)
    const existing = this.db.prepare('SELECT definition FROM budgets WHERE budget_id=?').get(definition.budgetId)
    if (existing && existing.definition !== encoded) throw new Error('Budget definition is immutable')
    if (!existing) this.db.prepare('INSERT INTO budgets VALUES (?,?,?)').run(definition.budgetId, encoded, now())
    return this.getBudget(definition.budgetId)
  }

  getBudget(budgetId) {
    text(budgetId, 'budgetId')
    const row = this.db.prepare('SELECT * FROM budgets WHERE budget_id=?').get(budgetId)
    if (!row) throw new Error('Unknown budget')
    const definition = JSON.parse(row.definition)
    const reservations = this.db.prepare('SELECT * FROM budget_reservations WHERE budget_id=? ORDER BY reservation_id').all(budgetId)
    let held = 0n, spent = 0n, upperBoundViolation = false
    const entries = reservations.map(r => {
      const history = this.db.prepare(`SELECT * FROM budget_settlements WHERE budget_id=? AND reservation_id=? ORDER BY sequence`)
        .all(budgetId, r.reservation_id)
      const last = history.at(-1)
      const settlement = last ? JSON.parse(last.definition) : null
      const known = history.map(s => JSON.parse(s.definition).actualMicrounits).filter(v => v !== null)
      if (known.some(v => v > r.upper_bound)) upperBoundViolation = true
      if (!settlement || settlement.actualMicrounits === null) held += BigInt(Math.max(r.upper_bound, ...known))
      else {
        spent += BigInt(settlement.actualMicrounits)
        if (settlement.actualMicrounits > r.upper_bound) upperBoundViolation = true
      }
      return { reservationId: r.reservation_id, attemptId: r.attempt_id, upperBoundMicrounits: r.upper_bound, settlement }
    })
    const remaining = BigInt(definition.limitMicrounits) - spent - held
    return { ...definition, heldMicrounits: safe(held), spentMicrounits: safe(spent),
      remainingMicrounits: remaining < 0n ? 0 : safe(remaining),
      violated: upperBoundViolation || remaining < 0n, reservations: entries }
  }

  reserve(input) {
    fields(input, ['budgetId', 'reservationId', 'attemptId', 'upperBoundMicrounits'], 'Reservation')
    for (const key of ['budgetId', 'reservationId', 'attemptId']) text(input[key], key)
    amount(input.upperBoundMicrounits)
    const existing = this.db.prepare('SELECT * FROM budget_reservations WHERE budget_id=? AND reservation_id=?').get(input.budgetId, input.reservationId)
    if (existing) {
      if (existing.attempt_id !== input.attemptId || existing.upper_bound !== input.upperBoundMicrounits) throw new Error('Reservation id conflict')
      return { ...input, created: false }
    }
    const attempt = this.db.prepare('SELECT state FROM attempts WHERE attempt_id=?').get(input.attemptId)
    if (!attempt || attempt.state !== 'running') throw new Error('A running attempt is required for reservation')
    const budget = this.getBudget(input.budgetId)
    if (budget.violated || input.upperBoundMicrounits > budget.remainingMicrounits) throw new Error('Budget unavailable or exceeded')
    this.db.prepare('INSERT INTO budget_reservations VALUES (?,?,?,?,?)')
      .run(input.budgetId, input.reservationId, input.attemptId, input.upperBoundMicrounits, now())
    return { ...input, created: true }
  }

  settle(input) {
    fields(input, ['budgetId', 'reservationId', 'settlementId', 'actualMicrounits', 'source'], 'Settlement')
    for (const key of ['budgetId', 'reservationId', 'settlementId', 'source']) text(input[key], key)
    if (input.actualMicrounits !== null) amount(input.actualMicrounits)
    const encoded = canonicalJson(input)
    const existing = this.db.prepare('SELECT definition FROM budget_settlements WHERE budget_id=? AND settlement_id=?').get(input.budgetId, input.settlementId)
    if (existing) {
      if (existing.definition !== encoded) throw new Error('Settlement id conflict')
    } else this.db.prepare('INSERT INTO budget_settlements (budget_id,reservation_id,settlement_id,definition,created_at) VALUES (?,?,?,?,?)')
      .run(input.budgetId, input.reservationId, input.settlementId, encoded, now())
    return this.getBudget(input.budgetId)
  }

  recordCorrection(attemptId, correctionId, input) {
    text(attemptId, 'attemptId'); text(correctionId, 'correctionId')
    fields(input, ['callId', 'billing'], 'Accounting correction')
    text(input.callId, 'callId'); validateBilling(input.billing)
    const encoded = canonicalJson(input)
    const existing = this.db.prepare('SELECT definition FROM accounting_corrections WHERE attempt_id=? AND correction_id=?').get(attemptId, correctionId)
    if (existing && existing.definition !== encoded) throw new Error('Accounting correction id conflict')
    if (!existing) this.db.prepare('INSERT INTO accounting_corrections (attempt_id,correction_id,definition,created_at) VALUES (?,?,?,?)')
      .run(attemptId, correctionId, encoded, now())
    return this.corrections(attemptId)
  }

  corrections(attemptId) {
    return this.db.prepare('SELECT * FROM accounting_corrections WHERE attempt_id=? ORDER BY sequence').all(attemptId)
      .map(r => ({ correctionId: r.correction_id, recordedAt: r.created_at, ...JSON.parse(r.definition) }))
  }

  exportRecords() {
    return [
      ...this.db.prepare('SELECT * FROM budgets ORDER BY budget_id').all().map(r => ['budget', { ...JSON.parse(r.definition), createdAt: r.created_at }]),
      ...this.db.prepare('SELECT * FROM budget_reservations ORDER BY budget_id,reservation_id').all().map(r => ['budgetReservation', {
        budgetId: r.budget_id, reservationId: r.reservation_id, attemptId: r.attempt_id, upperBoundMicrounits: r.upper_bound, createdAt: r.created_at }]),
      ...this.db.prepare('SELECT * FROM budget_settlements ORDER BY sequence').all().map(r => ['budgetSettlement', {
        sequence: r.sequence, ...JSON.parse(r.definition), recordedAt: r.created_at }]),
      ...this.db.prepare('SELECT * FROM accounting_corrections ORDER BY sequence').all().map(r => ['accountingCorrection', {
        attemptId: r.attempt_id, correctionId: r.correction_id, sequence: r.sequence, ...JSON.parse(r.definition), recordedAt: r.created_at }]),
    ]
  }
}
