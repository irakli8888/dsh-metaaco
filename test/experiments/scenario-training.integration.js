import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {learningTasks} from '../../examples/learning-tasks/index.js'
import {learningReferenceFiles} from '../fixtures/learning-reference.js'
import {runScenarioTraining} from '../../src/experiments/scenario-training.js'

test('online training advances isolated seed histories and admits experience into real MetaACO',async()=>{
 const root=await mkdtemp(join(tmpdir(),'training-feedback-'))
 const tasks=(await learningTasks()).slice(0,1)
 const code=learningReferenceFiles[tasks[0].request.taskId]
 let calls=0
 try{
  await assert.rejects(runScenarioTraining({tasks,seeds:[7,11],out:join(root,'denied'),budgetMicrounits:5000000}),/allowLlm/)
  const result=await runScenarioTraining({tasks,seeds:[7,11],rounds:4,out:join(root,'run'),budgetMicrounits:5000000,allowLlm:true,key:'synthetic-test-only',
   evaluationDockerImage:process.env.TEST_EVALUATION_IMAGE,fetchImpl:async(_url,options)=>{
    calls++;const body=JSON.parse(options.body),prompt=body.messages[0].content
    const d=JSON.parse(prompt.match(/Response discriminator: (\{[^\n]+?\})\./)[1]);let reply={...d,revision:'fixture'}
    if(d.kind==='architecture')reply.components=[{id:'a',files:['app.cjs'],contract:'Implement public factory'},{id:'b',files:['b.cjs'],contract:'Optional helpers'},{id:'c',files:['c.cjs'],contract:'Optional helpers'}]
    else if(prompt.includes('Your component is ')){
     const id=prompt.match(/Your component is ([abc])\./)[1];reply.files=id==='a'?{'app.cjs':code}:{[id+'.cjs']:'module.exports={};'}
    }else reply.files={'app.cjs':code}
    return {ok:true,json:async()=>({model:body.model,usage:{prompt_tokens:10,prompt_cache_miss_tokens:10,prompt_cache_hit_tokens:0,completion_tokens:10,total_tokens:20},choices:[{message:{content:JSON.stringify(reply)},finish_reason:'stop'}]})}
   }})
  assert.equal(result.rows.length,8)
  assert.ok(result.rows.every(r=>r.state==='succeeded'))
  for(const seed of [7,11])assert.deepEqual(result.rows.filter(r=>r.seed===seed).map(r=>r.historyCount),[0,1,2,3])
  assert.ok(result.rows.filter(r=>r.round>=2).every(r=>r.memorySeeds===1))
  assert.ok(result.rows.filter(r=>r.round>=2).every(r=>r.evidenceCount===r.round))
  assert.ok(calls>=24)
  assert.equal(result.budget.heldMicrounits,0)
  assert.equal(result.rows.reduce((n,r)=>n+r.costs[0].microunits,0),result.budget.spentMicrounits)
  const frozen=JSON.parse(await readFile(join(root,'run','frozen-training-refs.json'),'utf8'))
  assert.ok(frozen['7'].manifest.splits.train.every(id=>id.endsWith('seed-7')))
  assert.ok(frozen['11'].manifest.splits.train.every(id=>id.endsWith('seed-11')))
 }finally{await rm(root,{recursive:true,force:true})}
})
