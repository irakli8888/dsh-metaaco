// Components own disjoint files. The full monolithic task prompt must not be appended.
export const stockComponentPrompts = {
  'implement-stock': [
    'Return only stock.cjs in files. Never return subject.cjs.',
    'Export debit(stock, sku, quantity). If sku is missing or its available count is less than quantity, return null.',
    'Otherwise return a new stock map with quantity subtracted from sku. Preserve every other key and do not mutate stock.',
  ].join(' '),
  'implement-reservation': [
    'Return only subject.cjs in files. Never return stock.cjs.',
    'Require debit from ./stock.cjs. Export version() returning 1.',
    'Export reserve(stock, sku, quantity, id). Call debit(stock, sku, quantity).',
    'On null, return {stock, reservationId: null}. Otherwise return {stock: updatedStock, reservationId: id}.',
    'Do not mutate input stock.',
  ].join(' '),
}
