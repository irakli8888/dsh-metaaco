import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runOnlineStudy } from '../../src/experiments/online.js'
import { fixture, snapshot, price } from '../fixtures/adaptive.js'
import { EXPERIMENT_MODES } from '../../src/experiments/index.js'
import { searchOnlineSkills } from '../../src/experiments/skill-search.js'
import { StrategyBank } from '../../src/bank/index.js'

test('online histories start empty, update after terminal attempts and remain isolated', async t => {
  const f = fixture(t), root = await mkdtemp(join(tmpdir(), 'online-study-'))
  t.after(() => rm(root, {recursive:true, force:true}))
  f.plan.tasks[0].id = 'implement'
  f.plan.tasks[1].dependsOn = ['implement']
  f.plan.tasks[1].inputs = [{name:'source',taskId:'implement'}]
  const skills = Object.fromEntries(f.plan.tasks.map(task => [task.id,[{model:task.model,prompt:task.prompt,seconds:1,costMicrounits:5}]]))
  const config = { schemaVersion: 1, studyId: 'offline-online', seeds:[7,11], modes:[...EXPERIMENT_MODES], attemptsPerCell:2,
    task: {request:f.request, baseSnapshot:f.base}, policy:f.policy, runtimeConfig:{source:'synthetic'},
    fixedRouteId:'direct', routes:[{id:'direct',plan:f.plan,greenTaskId:'implement',refactorTaskId:'refactor',costMicrounits:10,wallTimeMs:100}],
    trainTaskIds:['train'], skills }
  const createRuntime = async ({guardAdapter, signal}) => {
    const adapter = guardAdapter({async *stream(){yield {type:'usage',usage:{inputTokens:2,outputTokens:1}};yield {type:'finish',reason:{kind:'stop'}}}},()=>({pricing:price,upperBoundMicrounits:6}))
    return {parent:{id:'parent'},subagentProvider:'offline',async dispose(){},ctx:{workflowEngine:{start(req){
      const result=(async()=>{for await(const chunk of adapter.stream({ ...req.args.model,signal })){};return {stopReason:'completed',value:JSON.stringify(snapshot(req.args.taskId))}})()
      return {id:req.args.taskId,result,cancel(){},async dispose(){}}
    }}}}
  }
  await assert.rejects(runOnlineStudy({out:join(root,'denied'),config,createRuntime}),/allowLlm/)
  const out=join(root,'run')
  const result=await runOnlineStudy({out,config,createRuntime,search:searchOnlineSkills,allowLlm:true})
  assert.equal(result.rows.length,28)
  for(const row of result.rows) {
    assert.equal(row.historyCount,row.round)
    assert.equal(row.state,'succeeded')
  }
  for(const mode of config.modes) for(const seed of config.seeds){
    const bank=new StrategyBank({dataDir:join(out,mode,String(seed))})
    assert.equal(bank.listAttempts().length,2)
    bank.close()
  }
  await assert.rejects(runOnlineStudy({out,config,createRuntime,search:searchOnlineSkills,allowLlm:true}),/EEXIST/)
  const leaked = structuredClone(config)
  leaked.trainTaskIds = ['heldout']
  await assert.rejects(runOnlineStudy({out:join(root,'leak'),config:leaked,createRuntime,search:searchOnlineSkills,allowLlm:true}), /explicit train/)
  const failedOut = join(root,'failed')
  const failureConfig = {...config,modes:['fixed'],seeds:[7],attemptsPerCell:2}
  await assert.rejects(runOnlineStudy({out:failedOut,config:failureConfig,allowLlm:true,
    createRuntime:async()=>{throw Error('fixture runtime unavailable')}}),/inconclusive/)
  const journal = (await readFile(join(failedOut,'journal.jsonl'),'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(journal.filter(row=>row.type==='result').length,1)
  assert.equal(journal.at(-1).type,'stopped')
  const failedBank = new StrategyBank({dataDir:join(failedOut,'fixed','7')})
  assert.equal(failedBank.listAttempts().length,1)
  assert.equal(failedBank.listAttempts()[0].state,'inconclusive')
  failedBank.close()
})

test('all baseline choices use only supplied same-task history', async () => {
  const { chooseOnlineRoute } = await import('../../src/experiments/online.js')
  const routes=[{id:'a',costMicrounits:2},{id:'b',costMicrounits:1}]
  const common={routes,fixedRouteId:'a',seed:7,round:0,history:[{routeId:'a',reward:-1},{routeId:'b',reward:1}]}
  assert.equal(chooseOnlineRoute({...common,mode:'historical-best'}).id,'b')
  assert.equal(chooseOnlineRoute({...common,mode:'contextual-bandit'}).id,'b')
  assert.equal(chooseOnlineRoute({...common,mode:'fixed'}).id,'a')
  assert.equal(chooseOnlineRoute({...common,mode:'cheapest'}).id,'b')
  assert.equal(chooseOnlineRoute({...common,mode:'random'}).id,chooseOnlineRoute({...common,mode:'random'}).id)
})

test('real MetaACO cold skill search returns a pinned route without bank access', async () => {
  const { searchOnlineSkills } = await import('../../src/experiments/skill-search.js')
  const { catalog, prompts, models } = await import('../../examples/stock-route-catalog.js')
  const skills=Object.fromEntries(Object.entries(prompts).map(([id,prompt])=>[id,models.map(model=>({model:{provider:'deepseek',model},prompt,seconds:4,costMicrounits:1}))]))
  const config={routes:catalog.map(({plan},i)=>({id:String(i),plan})),skills,policy:{maxCostMicrounits:100}}
  const result=await searchOnlineSkills({mode:'metaaco-without-bank',seed:7,round:0,history:[],config})
  assert.ok(config.routes.some(route=>route.id===result.routeId))
  assert.equal(result.evaluations,100)
  const learned=await searchOnlineSkills({mode:'metaaco-with-bank',seed:7,round:0,
    history:[{routeId:result.routeId,reward:-1}],config})
  assert.notEqual(learned.routeId,result.routeId)
  assert.equal(learned.exploration.selectedObservedAttempts,0)
  await assert.rejects(searchOnlineSkills({mode:'metaaco-without-bank',seed:7,round:0,history:[{routeId:'0',reward:1}],config}),/History forbidden/)
})

test('failed trajectories stay censored and missing costs never become zero', async () => {
  const {summarizeOnlineStudy}=await import('../../src/experiments/online.js')
  const rows=[{mode:'fixed',seed:7,round:0,state:'failed',verifiedSuccess:false,routeId:'a',totalWallTimeMs:5,costMicrounits:null,knownCostMicrounits:2}]
  const result=summarizeOnlineStudy(rows).trajectories[0]
  assert.equal(result.censored,true)
  assert.equal(result.firstSuccessAttempt,null)
  assert.equal(result.costToFirstOrCensorMicrounits,null)
  assert.equal(result.knownCostToFirstOrCensorMicrounits,2)
})
