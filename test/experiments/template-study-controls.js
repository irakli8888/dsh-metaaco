function csvRecords(csv) {
  const rows = []
  let row = [], field = '', quoted = false
  for (let i = 0; i < csv.length; i++) {
    const char = csv[i]
    if (char === '"') {
      if (quoted && csv[i + 1] === '"') { field += '"'; i++ }
      else quoted = !quoted
    } else if (!quoted && (char === ',' || char === '\n')) {
      row.push(field)
      field = ''
      if (char === '\n') { rows.push(row); row = [] }
    } else field += char
  }
  if (csv && (!csv.endsWith('\n') || row.length || field)) rows.push([...row, field])
  return rows
}

export const controls = {
  pagination: function paginate(items, page, size) {
    if (![page, size].every(n => Number.isInteger(n) && n > 0)) throw new RangeError()
    return { items: items.slice((page - 1) * size, page * size), total: items.length }
  },
  'stock-reservation': function reserve(stock, sku, quantity, id) {
    if (!Object.hasOwn(stock, sku) || stock[sku] < quantity) return { stock, reservationId: null }
    return { stock: { ...stock, [sku]: stock[sku] - quantity }, reservationId: id }
  },
  'order-csv': function exportOrders(orders) {
    const rows = orders.map(({ id, customer }) => [id, customer])
    const encode = field => {
      const text = String(field)
      return /[,"\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text
    }
    return [['id', 'customer'], ...rows].map(row => row.map(encode).join(',')).join('\n')
  },
  'event-range': function eventsInRange(events, start, end) {
    if (start > end) throw new RangeError()
    return events.filter(({ date }) => date >= start && date < end)
  },
  'seat-cancellation': function cancel(state, id) {
    if (!Object.hasOwn(state.reservations, id)) return state
    const { [id]: count, ...reservations } = state.reservations
    return { available: state.available + count, reservations }
  },
  'contact-csv': function importContacts(csv) {
    const contacts = [], errors = []
    csvRecords(csv).slice(1).forEach(([rawName, rawEmail], index) => {
      const name = rawName.trim(), email = rawEmail.trim()
      if (name && /^[^@]+@[^@]+$/.test(email)) contacts.push({ name, email })
      else errors.push({ row: index + 2 })
    })
    return { contacts, errors }
  },
}
export function controlSnapshot(taskId) {
  const implementation = controls[taskId]
  return { revision: 'control-v1', files: { 'subject.cjs':
    `${csvRecords.toString()}\nexports.version = () => 1;\nexports.${implementation.name} = ${implementation.toString()};\n`,
  } }
}
