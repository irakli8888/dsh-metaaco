import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compileStrategies } from '../../src/strategy-templates.js'

test('feature templates reuse topology across stacks and filter by task class', () => {
  const compile = (description, type) => compileStrategies({
    schemaVersion: 1, taskId: 'example', description, repo: 'fixture', baseCommit: 'base', testSpec: {}, provenance: {},
  }, { hints: { type }, budgetMicrounits: 30, model: { provider: 'offline', model: 'fixture' },
    resources: { agentSlots: 2, maxArtifactBytes: 1024, maxInputBytes: 4096, timeoutMs: 5000 },
    estimates: Object.fromEntries(['design', 'implement', 'write-tests', 'integrate'].map(id => [id, { seconds: 2, costMicrounits: 5 }])) })
  const java = compile('Implement a Java upload service', 'feature')
  const rust = compile('Implement a Rust command line tool', 'feature')
  assert.deepEqual(java.variants.map(v => v.id), ['direct-v1', 'contract-v1'])
  const tasks = result => result.variants[1].problem.plan.tasks
  assert.deepEqual(tasks(java).map(t => t.dependsOn), tasks(rust).map(t => t.dependsOn))
  assert.match(tasks(java)[0].prompt, /Java upload/)
  assert.match(tasks(rust)[0].prompt, /Rust command/)
  assert.deepEqual(compile('Fix a Java regression', 'bugfix').variants.map(v => v.id), ['direct-v1'])
  assert.equal(java.variants[1].costMicrounits, 20)
  assert.deepEqual(java.requiredTasks, ['implement'])
})

test('skill rules compose design and test branches independently with distinct model routes', () => {
  const routes = [{ provider: 'offline', model: 'small' }, { provider: 'offline', model: 'large' }]
  const spec = compileStrategies({
    schemaVersion: 1, taskId: 'example', description: 'Implement a Rust command', repo: 'fixture',
    baseCommit: 'base', testSpec: {}, provenance: {},
  }, { compose: true, model: routes[0], modelChoices: { implement: routes }, budgetMicrounits: 40,
    resources: { agentSlots: 2, maxArtifactBytes: 1024, maxInputBytes: 4096, timeoutMs: 5000 },
    estimates: Object.fromEntries(['design', 'implement', 'write-tests', 'integrate']
      .map(id => [id, { seconds: 2, costMicrounits: 5 }])),
  })
  assert.equal(spec.variants.length, 8)
  assert.ok(spec.variants.some(v => v.problem.plan.tasks.map(t => t.id).join(',') === 'design,implement'))
  assert.ok(spec.variants.some(v => v.problem.plan.tasks.map(t => t.id).join(',') === 'implement,write-tests,integrate'))
  assert.equal(new Set(spec.variants.map(v => v.id)).size, 8)
})
