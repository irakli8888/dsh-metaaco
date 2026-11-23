import {test} from 'node:test'
import assert from 'node:assert/strict'
import {webhookScenario} from '../../examples/webhook-scenario/index.js'
import {validateScenarioOutput,scenarioPrompt,skillDescriptor} from '../../src/experiments/scenario-runtime.js'
import {prepareScenarioJob} from '../../src/experiments/scenario-study.js'
import {runSuite} from '../../src/evaluation/runner.js'
import {webhookMonolithicReferenceFiles} from '../fixtures/webhook-reference.js'
const envelope=skill=>({task:skillDescriptor(skill),artifacts:[]})
const filesReply=files=>JSON.stringify({schemaVersion:2,kind:'files',revision:'generated',files})

test('webhook v3 opts into explicit response contract without changing v2 or public tests',async()=>{
  const old=await webhookScenario(),scenario=await webhookScenario({version:3})
  assert.equal(old.request.taskId,'webhook-retry-v2')
  assert.equal(old.responseContract,undefined)
  assert.equal(scenario.request.taskId,'webhook-retry-v3')
  assert.deepEqual(scenario.responseContract,{schemaVersion:2,readOnlyFiles:['README.md']})
  assert.match(scenario.request.description,/synchronously/)
  assert.match(scenario.request.description,/never.*Promise/)
  assert.deepEqual(scenario.request.testSpec.suites,old.request.testSpec.suites)
  assert.equal(prepareScenarioJob(scenario).schemaVersion,3)
})

test('host restores pinned files while preserving generated source exactly',async()=>{
  const scenario=await webhookScenario({version:3})
  scenario.baseSnapshot.files['config.json']='{"fixed":true}\n'
  scenario.responseContract.readOnlyFiles.push('config.json')
  const source='exports.version=()=>1;\n'
  const result=JSON.parse(validateScenarioOutput(filesReply({'app.cjs':source}),envelope('implement'),scenario,['a','b']))
  assert.equal(result.files['app.cjs'],source)
  assert.equal(result.files['README.md'],scenario.baseSnapshot.files['README.md'])
  assert.equal(result.files['config.json'],'{"fixed":true}\n')
  assert.deepEqual(Object.keys(result).sort(),['files','revision'])
  assert.throws(()=>validateScenarioOutput(filesReply({...result.files,'README.md':result.files['README.md']+'\n'}),envelope('implement'),scenario,['a','b']),/read.only/i)
  assert.throws(()=>validateScenarioOutput(filesReply({}),envelope('implement'),scenario,['a','b']),/omitted/)
  assert.throws(()=>validateScenarioOutput(filesReply({'app.cjs':source,'acceptance.test.cjs':'fake'}),envelope('implement'),scenario,['a','b']),/control tests/)
})

test('architecture DTO becomes existing artifact and retains disjoint component ownership',async()=>{
  const scenario=await webhookScenario({version:3})
  const components=[{id:'a',files:['app.cjs'],contract:'Public API'},{id:'b',files:['state.cjs'],contract:'State'}]
  const reply={schemaVersion:2,kind:'architecture',revision:'design',components}
  const normalized=validateScenarioOutput(JSON.stringify(reply),envelope('design'),scenario,['a','b'])
  assert.deepEqual(JSON.parse(JSON.parse(normalized).files['architecture.json']),{schemaVersion:1,components})
  const child={task:skillDescriptor('component','a'),artifacts:[{producer:'design',content:normalized}]}
  assert.deepEqual(JSON.parse(validateScenarioOutput(filesReply({'app.cjs':'source'}),child,scenario,['a','b'])).files,{'app.cjs':'source'})
  assert.throws(()=>validateScenarioOutput(filesReply({'state.cjs':'wrong owner'}),child,scenario,['a','b']),/ownership/)
  assert.throws(()=>validateScenarioOutput(JSON.stringify({...reply,type:'object'}),envelope('design'),scenario,['a','b']),/only/)
  assert.throws(()=>validateScenarioOutput(JSON.stringify({...reply,kind:'files'}),envelope('design'),scenario,['a','b']),/kind/)
})

test('new prompts distinguish wire responses from host artifacts',async()=>{
  const scenario=await webhookScenario({version:3})
  const prompt=scenarioPrompt(envelope('design'),scenario,['a','b','c'])
  assert.match(prompt,/"kind":"architecture"/)
  assert.match(prompt,/host.*architecture.json/i)
  assert.match(prompt,/read.only.*host/i)
  assert.doesNotMatch(prompt,/Return only architecture.json in files/)
})

test('v3 independent regression still rejects async handle; normalizer never repairs code',async()=>{
  const scenario=await webhookScenario({version:3})
  const source=webhookMonolithicReferenceFiles['app.cjs']+'\nconst syncFactory=exports.createApi;exports.createApi=(options)=>{const api=syncFactory(options);return {...api,handle:async(request)=>api.handle(request)}};\n'
  const snapshot=JSON.parse(validateScenarioOutput(filesReply({'app.cjs':source}),envelope('implement'),scenario,['a','b']))
  assert.equal(snapshot.files['app.cjs'],source)
  const report=await runSuite(scenario.request.testSpec,scenario.request.testSpec.suites[1],snapshot)
  assert.notEqual(report.status,'passed')
  assert.ok(report.tests.some(t=>t.type==='test:fail'&&t.message?.includes('Promise')))
})

test('read-only and response versions are validated before model dispatch',async()=>{
  const scenario=await webhookScenario({version:3})
  assert.throws(()=>scenarioPrompt(envelope('implement'),{...scenario,responseContract:{schemaVersion:99,readOnlyFiles:[]}},['a']),/Unsupported/)
  const missing=structuredClone(scenario);missing.responseContract.readOnlyFiles.push('missing.json')
  assert.throws(()=>scenarioPrompt(envelope('implement'),missing,['a']),/must exist/)
  const duplicate=structuredClone(scenario);duplicate.responseContract.readOnlyFiles.push('README.md')
  assert.throws(()=>scenarioPrompt(envelope('implement'),duplicate,['a']),/invalid/)
  assert.throws(()=>validateScenarioOutput(JSON.stringify({revision:'legacy',files:{'app.cjs':'code'}}),envelope('implement'),scenario,['a']),/version or kind/)
})
