import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createOutputBudget} from '../../src/experiments/output-budget.js'

test('output budget refunds complete usage and retains abandoned calls',async()=>{
  const budget=createOutputBudget({maxTokens:8,totalOutputTokens:16})
  let calls=0
  const adapter=budget.wrap({async *stream(){calls++;yield{type:'usage',usage:{outputTokens:2}};yield{type:'finish',reason:{kind:'stop'}}}})
  await Array.fromAsync(adapter.stream({}))
  assert.equal(budget.snapshot().used,2)
  for await(const chunk of adapter.stream({}))break
  assert.equal(budget.snapshot().held,8)
  await assert.rejects(Array.fromAsync(adapter.stream({})),/budget exceeded/)
  assert.equal(calls,2)
})

test('concurrent output reservations block before dispatch',async()=>{
  const budget=createOutputBudget({maxTokens:8,totalOutputTokens:8})
  let release,calls=0
  const wait=new Promise(resolve=>{release=resolve})
  const adapter=budget.wrap({async *stream(){calls++;await wait;yield{type:'usage',usage:{outputTokens:1}};yield{type:'finish',reason:{kind:'stop'}}}})
  const first=Array.fromAsync(adapter.stream({}))
  await Promise.resolve()
  try{await assert.rejects(Array.fromAsync(adapter.stream({})),/budget exceeded/)}finally{release()}
  await first
  assert.equal(calls,1)
})
