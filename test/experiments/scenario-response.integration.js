import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {StrategyBank} from '../../src/bank/index.js'
import {webhookScenario} from '../../examples/webhook-scenario/index.js'
import {webhookReferenceFiles} from '../fixtures/webhook-reference.js'
import {prepareScenarioJob,runScenarioTrial,SCENARIO_METHODS} from '../../src/experiments/scenario-study.js'

// Real Harness/evaluator, synthetic model output; no network or credentials.
for(const method of SCENARIO_METHODS)test(`typed response ${method} restores pinned files and passes independent tests`,async()=>{
  const scenario=await webhookScenario({version:3})
  const job=prepareScenarioJob(scenario,{method});job.policy.maxCostMicrounits=2000000
  const root=await mkdtemp(join(tmpdir(),'scenario-response-integration-'))
  const components=[{id:'a',files:['app.cjs'],contract:'Public API; use createStore and runOnce'},
    {id:'b',files:['store.cjs'],contract:'Export createStore'},
    {id:'c',files:['worker.cjs','signature.cjs'],contract:'Export runOnce and signature helper'}]
  let calls=0
  try{
    const report=await runScenarioTrial({job,out:join(root,'run'),evaluationDockerImage:process.env.TEST_EVALUATION_IMAGE,key:'synthetic-test-only',allowLlm:true,fetchImpl:async(_url,options)=>{
      calls++
      const body=JSON.parse(options.body),prompt=body.messages[0].content
      assert.equal(body.max_tokens,8192)
      const discriminator=JSON.parse(prompt.match(/Response discriminator: (\{[^\n]+?\})\./)[1])
      let reply={...discriminator,revision:'synthetic-source'}
      if(discriminator.kind==='architecture')reply.components=components
      else {
        let files={...webhookReferenceFiles}
        if(prompt.includes('Your component is ')){
          const id=prompt.match(/Your component is ([abc])\./)[1]
          files=Object.fromEntries(components.find(c=>c.id===id).files.map(path=>[path,webhookReferenceFiles[path]]))
        }
        assert.equal(Object.hasOwn(files,'README.md'),false)
        reply.files=files
      }
      return {ok:true,json:async()=>({model:body.model,usage:{prompt_tokens:10,prompt_cache_miss_tokens:10,prompt_cache_hit_tokens:0,completion_tokens:10,total_tokens:20},
        choices:[{message:{content:JSON.stringify(reply)},finish_reason:'stop'}]})}
    }})
    assert.equal(report.acceptancePassed,true,JSON.stringify(report))
    assert.equal(calls,method==='components'?6:method.startsWith('direct-')?1:2)
    const bank=new StrategyBank({dataDir:join(root,'run','bank')})
    try{
      const records=bank.exportJsonl().trim().split('\n').map(JSON.parse)
      const refs=records.filter(r=>r.type==='attemptArtifact').map(r=>r.value)
      const raw=refs.find(r=>r.name.startsWith('scenario-output-')&&r.name!=='scenario-output-budget')
      const normalized=refs.find(r=>r.name==='scenario-normalized-'+raw.name.slice('scenario-output-'.length))
      assert.ok(normalized)
      const rawValue=JSON.parse(await readFile(join(root,'run','bank','artifacts',raw.sha256),'utf8'))
      const normalizedValue=JSON.parse(await readFile(join(root,'run','bank','artifacts',normalized.sha256),'utf8'))
      assert.equal(rawValue.schemaVersion,2)
      assert.deepEqual(Object.keys(normalizedValue).sort(),['files','revision'])
      const final=refs.find(r=>r.name==='dag-output/'+(method.startsWith('direct-')?'implement':'refactor'))
      const snapshot=JSON.parse(await readFile(join(root,'run','bank','artifacts',final.sha256),'utf8'))
      assert.equal(snapshot.files['README.md'],scenario.baseSnapshot.files['README.md'])
    }finally{bank.close()}
  }finally{await rm(root,{recursive:true,force:true})}
})
