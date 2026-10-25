import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validatePlan, runPlannedWorkflow } from '../planner.js'

const plan = () => ({ version: 1, planner: 'python-metaaco', execution: 'serial-order', workflow: {
  name: 'planned', description: 'Real solver output boundary', stages: [
    { title: 'Job 1', agents: [{ id: 'first', prompt: 'first' }] },
    { title: 'Job 2', agents: [{ id: 'second', prompt: 'second' }] },
  ],
} })

test('contract rejects unknown versions, executable fields, parallel stages and duplicate jobs', () => {
  for (const mutate of [p => p.version = 2, p => p.script = 'evil',
    p => p.execution = 'timed', p => p.workflow.stages[0].agents.push({ id: 'extra', prompt: 'x' }),
    p => p.workflow.stages[1].agents[0].id = 'first']) {
    const p = plan(); mutate(p); assert.throws(() => validatePlan(p))
  }
  const p = plan(), snapshot = validatePlan(p)
  p.workflow.stages[0].agents[0].prompt = 'changed'
  assert.equal(snapshot.workflow.stages[0].agents[0].prompt, 'first')
})

test('plan execution requires explicit consent before touching the engine', async () => {
  for (const allowLlm of [undefined, false, 'true', 1]) {
    await assert.rejects(runPlannedWorkflow({}, {}, plan(), { allowLlm }), /allowLlm/)
  }
})

test('approved plan forwards validated data and runtime options; disposal on rejection', async () => {
  const parent = {}, controller = new AbortController()
  let disposed = 0
  const ctx = { workflowEngine: { start(request) {
    assert.equal(request.parent, parent)
    assert.equal(request.subagentProvider, 'offline')
    assert.equal(request.signal, controller.signal)
    assert.equal(request.maxTotalAgents, 2)
    assert.deepEqual(request.args.stages, plan().workflow.stages)
    return { result: Promise.reject(new Error('runtime failed')), cancel() {},
      async dispose() { disposed++ } }
  } } }
  await assert.rejects(runPlannedWorkflow(ctx, parent, plan(), {
    allowLlm: true, signal: controller.signal, subagentProvider: 'offline',
  }), /runtime failed/)
  assert.equal(disposed, 1)
})
