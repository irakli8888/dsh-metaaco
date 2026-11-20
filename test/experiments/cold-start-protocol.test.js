import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coldStartProtocol, validateColdStartProtocol } from '../../examples/cold-start-protocol.js'

test('cold-start design pins paired conditions and remains offline', () => {
  const result = validateColdStartProtocol(coldStartProtocol())
  assert.equal(result.maximumAttempts, 700)
  assert.equal(result.isolatedBanks, 35)
  assert.equal(result.apiCalls, 0)
  assert.equal(result.readyForPaidExecution, false)
})

for (const mutate of [
  config => { config.externalExperienceAllowed = true },
  config => { config.splits.test.push('stock-reservation') },
  config => { config.initialHistory = 'exhaustive-v1' },
  config => { config.seeds.push(7) },
  config => { config.concurrentAttempts = 4 },
]) test('modified or leaking v1 conditions reject before dispatch', () => {
  const config = coldStartProtocol()
  mutate(config)
  assert.throws(() => validateColdStartProtocol(config))
})
