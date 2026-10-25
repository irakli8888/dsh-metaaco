import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { apply, runWorkflow, validateWorkflow } from '../index.js'

const fixture = JSON.parse(await readFile(new URL('../examples/two-agents.json', import.meta.url)))

test('fixed script starts two children concurrently and waits for both before the next stage', async () => {
  const workflow = structuredClone(fixture)
  workflow.stages.push({ title: 'Finish', agents: [{ id: 'finish', prompt: 'finish' }] })
  const parent = {}, calls = [], active = new Set()
  let disposed = false, maxActive = 0
  const ctx = { workflowEngine: { start(request) {
    assert.equal(request.parent, parent)
    assert.equal(request.maxTotalAgents, 3)
    assert.equal(request.subagentProvider, 'spawn')
    const execute = new Function('agent', 'parallel', 'phase', 'args', `return (async () => {${request.script}})()`)
    return {
      id: 'unit-run', cancel() {},
      result: execute(async (prompt, { label }) => {
        if (label === 'finish') assert.equal(active.size, 0)
        calls.push(label); active.add(label); maxActive = Math.max(maxActive, active.size)
        await new Promise(resolve => setTimeout(resolve, 5))
        active.delete(label)
        return `reply:${label}`
      }, thunks => Promise.all(thunks.map(fn => fn())), () => {}, request.args)
        .then(value => ({ stopReason: 'completed', agentsStarted: calls.length, value })),
      async dispose() { disposed = true },
    }
  } } }
  const result = await runWorkflow(ctx, parent, workflow)
  assert.equal(maxActive, 2)
  assert.deepEqual(calls, ['java', 'aco', 'finish'])
  assert.equal(result.result.aco, 'reply:aco')
  assert.equal(disposed, true)
})

test('preview and invalid command never start the engine; explicit flag passes invocation.agent', async () => {
  let command, starts = 0, disposed = 0
  const parent = {}, signal = new AbortController().signal
  apply({ commands: { register(value) { command = value } }, workflowEngine: { start(request) {
    starts++; assert.equal(request.parent, parent)
    return { id: 'test', result: Promise.resolve({ stopReason: 'completed', agentsStarted: 2, value: {} }),
      cancel() {}, async dispose() { disposed++ } }
  } } }, { workflowFile: new URL('../examples/two-agents.json', import.meta.url).pathname })
  const invoke = rawInput => command.handler({ agent: parent, rawInput, signal })
  assert.equal(JSON.parse((await invoke('')).text).preview, true)
  assert.equal((await invoke(' yes')).kind, 'error')
  assert.equal(starts, 0)
  assert.equal((await invoke(' --allow-llm')).kind, 'success')
  assert.equal(starts, 1); assert.equal(disposed, 1)
})

test('failed run is disposed and pre-aborted call never starts', async () => {
  let disposed = 0, starts = 0, cancel = 0
  const controller = new AbortController()
  const ctx = { workflowEngine: { start() {
    starts++
    return { result: Promise.resolve({ stopReason: 'cancelled', error: 'stopped' }),
      cancel() { cancel++ }, async dispose() { disposed++ } }
  } } }
  const pending = runWorkflow(ctx, {}, fixture, { signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, /cancelled/)
  assert.equal(cancel, 1); assert.equal(disposed, 1)
  await assert.rejects(runWorkflow(ctx, {}, fixture, { signal: controller.signal }))
  assert.equal(starts, 1)
})

test('JSON cannot inject script or duplicate child identifiers', () => {
  assert.throws(() => validateWorkflow({ ...fixture, script: 'malicious' }))
  const workflow = structuredClone(fixture)
  workflow.stages[0].agents[1].id = 'java'
  assert.throws(() => validateWorkflow(workflow), /unique/)
})

test('null child failure prevents dependent stage and still disposes run', async () => {
  const workflow = structuredClone(fixture)
  workflow.stages.push({ title: 'Dependent', agents: [{ id: 'dependent', prompt: 'never' }] })
  const started = []
  let disposed = false
  const ctx = { workflowEngine: { start(request) {
    const execute = new Function('agent', 'parallel', 'phase', 'args', `return (async () => {${request.script}})()`)
    return { cancel() {}, result: execute(async (_prompt, { label }) => {
      started.push(label); return label === 'java' ? null : 'ok'
    }, thunks => Promise.all(thunks.map(fn => fn())), () => {}, request.args)
      .then(value => ({ stopReason: 'completed', value }),
        error => ({ stopReason: 'error', error: error.message })),
    async dispose() { disposed = true } }
  } } }
  await assert.rejects(runWorkflow(ctx, {}, workflow), /dependent stages were not started/)
  assert.deepEqual(started, ['java', 'aco'])
  assert.equal(disposed, true)
})
