const definitions = [
  ['train', 'pagination', 'paginate', 'Add paginate(items, page, size). Pages start at 1. Return {items,total}, preserve order, and throw RangeError for nonpositive or noninteger page or size.', [
    [[[3, 1, 2], 1, 2], { items: [3, 1], total: 3 }],
    [[[3, 1, 2], 2, 2], { items: [2], total: 3 }],
    [[[], 1, 2], { items: [], total: 0 }],
    [[[1], 1, 0], null, 'RangeError'],
  ]],
  ['train', 'stock-reservation', 'reserve', 'Add reserve(stock, sku, quantity, id). stock maps SKU to available count. Return {stock,reservationId} with updated stock on success, or unchanged stock and null ID on shortage. Do not mutate input.', [
    [[{ a: 4, b: 2 }, 'a', 4, 'r1'], { stock: { a: 0, b: 2 }, reservationId: 'r1' }],
    [[{ a: 1 }, 'a', 2, 'r2'], { stock: { a: 1 }, reservationId: null }],
    [[{}, 'unknown', 1, 'r3'], { stock: {}, reservationId: null }],
  ]],
  ['train', 'order-csv', 'exportOrders', 'Add exportOrders(orders). Each order has id and customer. Separate row preparation and CSV encoding. Return id,customer header followed by LF-separated rows without trailing LF. Quote fields containing comma, quote, CR or LF and double embedded quotes.', [
    [[[]], 'id,customer'],
    [[[ { id: 1, customer: 'A,B' }, { id: 2, customer: 'C"D\nE' } ]], 'id,customer\n1,"A,B"\n2,"C""D\nE"'],
  ]],
  ['test', 'event-range', 'eventsInRange', 'Add eventsInRange(events,start,end). Each event has date as YYYY-MM-DD. Return matching events in original order with inclusive start and exclusive end. Throw RangeError when start exceeds end.', [
    [[[ { date: '2025-01-02' }, { date: '2025-01-01' }, { date: '2025-01-03' } ], '2025-01-01', '2025-01-03'], [{ date: '2025-01-02' }, { date: '2025-01-01' }]],
    [[[ { date: '2025-01-02' } ], '2025-01-02', '2025-01-02'], []],
    [[[], '2025-01-03', '2025-01-01'], null, 'RangeError'],
  ]],
  ['test', 'seat-cancellation', 'cancel', 'Add cancel(state,id). State contains available and reservations mapping IDs to seat counts. Return a new state that releases seats and removes the reservation. Unknown IDs leave state values unchanged. Do not mutate input.', [
    [[{ available: 2, reservations: { a: 3, b: 1 } }, 'a'], { available: 5, reservations: { b: 1 } }],
    [[{ available: 5, reservations: { b: 1 } }, 'a'], { available: 5, reservations: { b: 1 } }],
  ]],
  ['test', 'contact-csv', 'importContacts', 'Add importContacts(csv) with separate CSV parsing and validation. Input is valid CSV with name,email header, LF separators and optional final LF. Support quoted fields, embedded commas and doubled quotes. Empty input is valid. Return {contacts,errors}; trim fields, reject empty name or email without exactly one @ and nonempty sides. Error rows are 1-based record numbers including header. Error shape {row}.', [
    [[''], { contacts: [], errors: [] }],
    [['name,email\n"A, B",a@example.com\nBad,invalid\n"C""D",c@example.com'], {
      contacts: [{ name: 'A, B', email: 'a@example.com' }, { name: 'C"D', email: 'c@example.com' }], errors: [{ row: 3 }],
    }],
  ]],
]

export function templateStudyTasks() {
  return definitions.map(([split, taskId, fn, description, cases]) => {
    const caseNames = cases.map((_, index) => `acceptance-${index + 1}`)
    const target = cases.map(([args, expected, error], index) => {
      const check = error ? `assert.throws(() => subject.${fn}(...args), { name: ${JSON.stringify(error)} })`
        : `assert.deepEqual(subject.${fn}(...args), ${JSON.stringify(expected)})`
      return `test(${JSON.stringify(caseNames[index])}, () => {
        const args = ${JSON.stringify(args)}
        const before = structuredClone(args)
        ${check}
        assert.deepEqual(args, before)
      })`
    }).join('\n')
    const baseSnapshot = { revision: 'base-v1', files: {
      'subject.cjs': `exports.version = () => 1;\nexports.${fn} = () => undefined;\n`,
    } }
    const prefix = "const { test } = require('node:test'); const assert = require('node:assert/strict'); const subject = require('./subject.cjs');\n"
    const testSpec = { schemaVersion: 1, id: taskId, acceptanceCriteria: [description], timeoutMs: 15000, maxOutputBytes: 100000,
      suites: [
        { id: 'target', kind: 'target', expectedRedTests: caseNames, files: { 'target.test.cjs': prefix + target } },
        { id: 'regression', kind: 'regression', expectedRedTests: [], files: {
          'regression.test.cjs': prefix + "test('version API', () => assert.equal(subject.version(), 1));",
        } },
      ] }
    return { split, baseSnapshot, request: { schemaVersion: 1, taskId, repo: 'template-study-v1',
      description: `${description} Use JavaScript CommonJS in subject.cjs and preserve version(). Starting snapshot: ${JSON.stringify(baseSnapshot)}`,
      baseCommit: baseSnapshot.revision, testSpec, provenance: { source: 'template-study-v1' } } }
  })
}
