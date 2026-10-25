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


test('start-groups accepts multiple children and snapshots the group', () => {
  const p = plan()
  p.execution = 'start-groups'
  p.workflow.stages[0].agents.push({ id: 'parallel', prompt: 'parallel work' })
  const snapshot = validatePlan(p)
  assert.equal(snapshot.count, 3)
  assert.equal(snapshot.workflow.stages[0].agents.length, 2)
  p.workflow.stages[0].agents.pop()
  assert.equal(snapshot.workflow.stages[0].agents.length, 2)
})

const resourcePlan = () => ({ ...plan(), version: 2, execution: 'start-groups',
  resources: { agentSlots: 2 },
  estimates: { objective: 'makespan', durationUnit: 'seconds', scheduleMakespan: 40, executionMakespan: 50 },
})

test('v2 previews resource limits and distinct estimates without starting anything', () => {
  const p = resourcePlan()
  const preview = validatePlan(p)
  assert.equal(preview.resources.agentSlots, 2)
  assert.equal(preview.estimates.scheduleMakespan, 40)
  assert.equal(preview.estimates.executionMakespan, 50)
  p.resources.agentSlots = 100
  p.estimates.scheduleMakespan = 1
  assert.equal(preview.resources.agentSlots, 2)
  assert.equal(preview.estimates.scheduleMakespan, 40)
})

test('v2 rejects invalid limits, estimates and stages exceeding slot capacity', async () => {
  for (const mutate of [p => p.resources.agentSlots = 0, p => p.resources.agentSlots = true,
    p => p.resources.agentSlots = 1.5, p => p.resources.agentSlots = Number.MAX_SAFE_INTEGER + 1,
    p => p.resources.tokenBudget = 100, p => delete p.estimates,
    p => p.estimates.objective = 'answer-quality', p => p.estimates.durationUnit = 'tokens',
    p => p.estimates.scheduleMakespan = NaN, p => p.estimates.executionMakespan = -1,
    p => p.estimates.cost = 5, p => p.version = 3,
    p => { p.resources.agentSlots = 1; p.workflow.stages[0].agents.push({ id: 'extra', prompt: 'x' }) }]) {
    const p = resourcePlan(); mutate(p)
    assert.throws(() => validatePlan(p))
    // Invalid data cannot reach an engine even when explicit execution is requested.
    await assert.rejects(runPlannedWorkflow({}, {}, p, { allowLlm: true }))
  }
  await assert.rejects(runPlannedWorkflow({}, {}, resourcePlan()), /allowLlm/)
  const legacy = plan(); legacy.resources = { agentSlots: 2 }
  assert.throws(() => validatePlan(legacy))
})
