import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runFrozenStudy } from '../../src/experiments/frozen-online.js'

test('frozen dispatch requires consent before any filesystem access', async () => {
  await assert.rejects(runFrozenStudy({}), /allowLlm/)
})

test('seven methods seal choices before execution and never learn from repeats', async t => {
  const {mkdtemp,rm,readFile}=await import('node:fs/promises')
  const {join}=await import('node:path')
  const {tmpdir}=await import('node:os')
  const {fixture,snapshot,price}=await import('../fixtures/adaptive.js')
  const {EXPERIMENT_MODES}=await import('../../src/experiments/index.js')
  const {searchFrozenSkills}=await import('../../src/experiments/skill-search.js')
  const {hash}=await import('../../src/selector/contracts.js')
  const f=fixture(t), parent=await mkdtemp(join(tmpdir(),'frozen-test-'))
  t.after(()=>rm(parent,{recursive:true,force:true}))
  f.plan.tasks[0].id='implement'
  f.plan.tasks[1].dependsOn=['implement']
  f.plan.tasks[1].inputs=[{name:'source',taskId:'implement'}]
  const config={schemaVersion:1,studyId:'frozen-fixture',task:{request:f.request,baseSnapshot:f.base},
    seeds:[7],modes:[...EXPERIMENT_MODES],attemptsPerCell:1,trainTaskIds:['train'],policy:{...f.policy,alpha:0},
    runtimeConfig:{source:'synthetic'},fixedRouteId:'direct',
    routes:[{id:'direct',plan:f.plan,greenTaskId:'implement',refactorTaskId:'refactor',costMicrounits:10,wallTimeMs:100}],
    skills:Object.fromEntries(f.plan.tasks.map(task=>[task.id,[{model:task.model,prompt:task.prompt,seconds:1,costMicrounits:5}]]))}
  config.primaryMetric='acceptance-correctness-v2'
  for(const mode of ['direct-flash','direct-pro']) {
    config.modes.push(mode)
    config.routes.push({id:mode,plan:{...f.plan,tasks:[f.plan.tasks[0]]},greenTaskId:'implement',refactorTaskId:null,costMicrounits:5,wallTimeMs:50})
  }
  const experience={history:[{attemptId:'source/one',routeId:'direct',reward:1}]}
  const originalHash=hash(experience),seen=[]
  const search=async args=>{seen.push({mode:args.mode,count:args.history.length});return searchFrozenSkills(args)}
  const createRuntime=async({guardAdapter,signal,mode,repeat})=>{
    const adapter=guardAdapter({async *stream(){yield{type:'usage',usage:{inputTokens:2,outputTokens:1}};yield{type:'finish',reason:{kind:'stop'}}}},()=>({pricing:price,upperBoundMicrounits:6}))
    return {parent:{id:'parent'},subagentProvider:'offline',async dispose(){},ctx:{workflowEngine:{start(req){
      const result=(async()=>{for await(const part of adapter.stream({...req.args.model,signal})){};return{stopReason:'completed',value:JSON.stringify(snapshot(req.args.taskId,['historical-best','direct-pro'].includes(mode)&&repeat===0?'0':'a+b'))}})()
      return{id:req.args.taskId,result,cancel(){},async dispose(){}}
    }}}}
  }
  const out=join(parent,'study')
  const result=await runFrozenStudy({out,config,experience,repeats:2,createRuntime,search,allowLlm:true})
  assert.equal(result.rows.length,18)
  assert.equal(result.rows.filter(r=>r.verifiedSuccess).length,16)
  assert.equal(hash(experience),originalHash)
  for(const row of result.rows.filter(r=>r.mode.startsWith('direct-'))) {
    assert.equal(row.modelCalls,1)
    const failed=row.mode==='direct-pro'&&row.repeat===0
    assert.equal(row.correctness,failed?'failed':'passed')
    assert.equal(row.tddCompliance,failed?'failed':'inconclusive')
    assert.equal(row.state,failed?'failed':'inconclusive')
    assert.equal(row.verifiedSuccess,!failed)
  }
  assert.deepEqual(seen.map(r=>r.count).sort(),[0,1])
  const journal=(await readFile(join(out,'journal.jsonl'),'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(journal.slice(0,9).filter(r=>r.type==='decision').length,9)
  const decisions=journal.filter(r=>r.type==='decision')
  for(const decision of decisions) {
    assert.equal(decision.historyCount,['historical-best','contextual-bandit','metaaco-with-bank'].includes(decision.mode)?1:0)
    if(decision.mode==='metaaco-with-bank') assert.equal(decision.decision.exploration,null)
  }
  const historical=result.rows.filter(r=>r.mode==='historical-best')
  assert.equal(historical[0].historyHash,historical[1].historyHash)
  await assert.rejects(runFrozenStudy({out,config,experience,repeats:2,createRuntime,search,allowLlm:true}),/EEXIST/)
})

test('changed source summary rejects before opening training banks', async t => {
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises')
  const {join}=await import('node:path')
  const {tmpdir}=await import('node:os')
  const {loadFrozenExperience}=await import('../../src/experiments/frozen-source.js')
  const directory=await mkdtemp(join(tmpdir(),'frozen-source-'))
  t.after(()=>rm(directory,{recursive:true,force:true}))
  await writeFile(join(directory,'summary.json'),'{}')
  await assert.rejects(loadFrozenExperience(directory,{sourceSummarySha256:'0'.repeat(64)}),/Source summary changed/)
})
