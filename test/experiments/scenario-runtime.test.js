import {test} from 'node:test'
import assert from 'node:assert/strict'
import {webhookScenario} from '../../examples/webhook-scenario/index.js'
import {validateArchitecture,validateScenarioOutput,scenarioPrompt,skillDescriptor} from '../../src/experiments/scenario-runtime.js'

test('architecture defines private interfaces and disjoint ownership at runtime',async()=>{
  const scenario=await webhookScenario()
  const architecture={schemaVersion:1,components:[{id:'a',files:['app.cjs'],contract:'Public service'},{id:'b',files:['state.cjs'],contract:'State API'}]}
  validateArchitecture(architecture,scenario,['a','b'])
  const parent={producer:'design',content:JSON.stringify({revision:'design',files:{'architecture.json':JSON.stringify(architecture)}})}
  const envelope={task:skillDescriptor('component','a'),artifacts:[parent]}
  const output=JSON.stringify({revision:'code',files:{'app.cjs':'exports.version=()=>1'}})
  assert.equal(validateScenarioOutput(output,envelope,scenario,['a','b']),output)
  assert.throws(()=>validateScenarioOutput(JSON.stringify({revision:'bad',files:{'state.cjs':'other'}}),envelope,scenario,['a','b']),/ownership/)
  const duplicate=structuredClone(architecture);duplicate.components[1].files=['app.cjs']
  assert.throws(()=>validateArchitecture(duplicate,scenario,['a','b']),/ownership/)
  assert.throws(()=>validateArchitecture({schemaVersion:1,components:[{id:'a',files:['../escape.cjs'],contract:'bad'}]},scenario,['a']),/path/i)
})


test('prompt identifies immutable specification and validator rejects edits',async()=>{
  const scenario=await webhookScenario()
  const envelope={task:skillDescriptor('implement'),artifacts:[]}
  assert.match(scenarioPrompt(envelope,scenario,['a','b','c']),/Immutable project files:.*README.md/)
  assert.throws(()=>validateScenarioOutput(JSON.stringify({revision:'invalid',files:{...scenario.baseSnapshot.files,'README.md':'Changed'}}),envelope,scenario,['a','b','c']),/pinned specification/)
})
