import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {StrategyBank} from '../bank/index.js'
import {advanceFeedback} from '../feedback/index.js'
import {armId} from '../selector/contracts.js'
import {runAdaptiveAttempt} from '../orchestration/index.js'
import {runDirectAttempt} from './direct-attempt.js'
import {validateDag} from '../execution/contracts.js'
import {validateSnapshot,validateSpec} from '../evaluation/runner.js'
import {createDeepSeekAdapter} from '../adapters/harness/deepseek.js'
import {skillDescriptor,createScenarioRuntime} from './scenario-runtime.js'

export const SCENARIO_METHODS=['direct-flash','direct-pro','fixed','components','metaaco']
export const SCENARIO_LIMITS={maxTokens:8192,totalOutputTokens:32768,maxInputBytes:262144,requestTimeoutMs:120000}
const models=['deepseek-flash','deepseek-v4-pro']

export function prepareScenarioJob(scenario,{method='metaaco',seed=7}={}) {
  if(!SCENARIO_METHODS.includes(method)||!Number.isInteger(seed)||seed<0||seed>0xffffffff)throw Error('Invalid scenario method or seed')
  validateSnapshot(scenario.baseSnapshot);validateSpec(scenario.request.testSpec)
  const limits={...SCENARIO_LIMITS},componentIds=['a','b','c']
  const {quote}=createDeepSeekAdapter({key:'offline-quote-only',...limits})
  const prices=Object.fromEntries(models.map(model=>[model,quote({provider:'deepseek',model,system:'Pinned scenario request'})]))
  const resources={agentSlots:2,timeoutMs:300000,maxArtifactBytes:65536,maxInputBytes:limits.maxInputBytes}
  const instruction=(skill,componentId)=>skillDescriptor(skill,componentId)
  const skills={}
  for(const skill of ['implement','refactor','design','integrate','analyze','review','write-tests',...componentIds.map(id=>'implement-'+id)]){
    skills[skill]=models.map(model=>({model:{provider:'deepseek',model},prompt:instruction(skill.startsWith('implement-')?'component':skill,skill.startsWith('implement-')?skill.slice(10):null),
      seconds:10,costMicrounits:prices[model].upperBoundMicrounits}))
  }
  const policy={schemaVersion:1,revision:'scenario-v1',alpha:0,lambda:1,weights:{quality:1,time:0,cost:0},
    normalization:{wallTimeMs:300000,costMicrounits:1000000},currency:'USD',allowedModels:models.map(model=>'deepseek/'+model),
    allowedTools:[],maxConcurrency:2,maxWallTimeMs:300000,maxCostMicrounits:9*prices[models[1]].upperBoundMicrounits,minQuality:null}
  return {schemaVersion:1,scenario:structuredClone(scenario),method,seed,limits,componentIds,resources,skills,policy,prices,
    history:'empty; no stock observations',forecastSource:'uncalibrated equal 10-second priors for every skill/model; technical tariff bounds'}
}

export async function planScenarioJob(job,{signal}={}) {
  if(job.method==='metaaco') {
    const dir=await mkdtemp(join(tmpdir(),'scenario-plan-'))
    try{
      const path=join(dir,'input.json')
      await writeFile(path,JSON.stringify({skills:job.skills,resources:job.resources,budgetMicrounits:job.policy.maxCostMicrounits,
        qualityEvidence:[],componentDesignRequired:true}),{mode:0o600})
      const {stdout}=await promisify(execFile)('python3',['-B',fileURLToPath(new URL('../../python/skill_decisions.py',import.meta.url)),path,'--seed',String(job.seed)],{signal,timeout:30000,maxBuffer:4*1024*1024})
      const selection=JSON.parse(stdout)
      const byId=new Map(selection.problem.plan.tasks.map(task=>[task.id,task]))
      const plan=validateDag({...selection.problem.plan,tasks:selection.dispatchOrder.map(id=>byId.get(id))})
      return {plan,selection}
    }finally{await rm(dir,{recursive:true,force:true})}
  }
  const tasks=[]
  const add=(id,skill,parents=[],componentId=null,model=models[0])=>tasks.push({id,prompt:skillDescriptor(skill,componentId),dependsOn:parents,
    inputs:parents.map(taskId=>({name:taskId,taskId})),slots:1,model:{provider:'deepseek',model}})
  if(job.method.startsWith('direct-'))add('implement','implement',[],null,job.method==='direct-pro'?models[1]:models[0])
  else if(job.method==='components'){
    add('design','design')
    for(const id of job.componentIds)add('implement-'+id,'component',['design'],id)
    add('integrate','integrate',['design',...job.componentIds.map(id=>'implement-'+id)])
    add('refactor','refactor',['integrate'])
  }else{add('implement','implement');add('refactor','refactor',['implement'])}
  return {plan:validateDag({version:3,execution:'dag',name:'scenario-'+job.method,description:'Task-aware scenario workflow',resources:job.resources,tasks}),selection:null}
}

export async function runScenarioJob({job,out,evaluationDockerImage,createRuntime,key,fetchImpl,allowLlm=false,signal}) {
  if(allowLlm!==true)throw Error('Explicit allowLlm: true required')
  signal?.throwIfAborted()
  const {mkdir}=await import('node:fs/promises')
  await mkdir(out,{mode:0o700})
  await writeFile(join(out,'job.json'),JSON.stringify(job,null,2),{flag:'wx',mode:0o600})
  const start=performance.now()
  let planned
  try{planned=await planScenarioJob(job,{signal})}catch(error){
    await writeFile(join(out,'planning-error.json'),JSON.stringify({schemaVersion:1,state:signal?.aborted?'cancelled':'failed',message:error.message},null,2),{mode:0o600})
    throw error
  }
  const manifest={schemaVersion:1,job,planned,evaluationDockerImage:evaluationDockerImage??null,node:process.version}
  await writeFile(join(out,'manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx',mode:0o600})
  const selectionWallTimeMs=performance.now()-start
  const bank=new StrategyBank({dataDir:join(out,'bank')})
  const attemptId='scenario-attempt'
  const runtime=args=>createRuntime?createRuntime({...args,job,bank}):createScenarioRuntime({...args,bank,key,fetchImpl,
    scenario:job.scenario,componentIds:job.componentIds,limits:job.limits})
  try {
    const direct=job.method.startsWith('direct-')
    const plan=planned.plan
    const cost=plan.tasks.reduce((sum,t)=>sum+job.prices[t.model.model].upperBoundMicrounits,0)
    const route={id:'scenario-'+job.method,plan,wallTimeMs:plan.tasks.length*10000,costMicrounits:cost}
    let result
    if(direct) result=await runDirectAttempt({bank,attemptId,task:job.scenario,route,policy:job.policy,createRuntime:runtime,
      evaluationDockerImage,allowLlm:true,signal,selection:{manifest:'scenario-v1',selectionWallTimeMs}})
    else {
      const strategy=bank.register({schemaVersion:1,strategyId:route.id,version:1,provenance:{source:'scenario-v1'},
        workflow:{name:route.id,description:'Task-aware workflow',stages:[{title:'Code',agents:[{id:'coder',prompt:'Implement'}]}]}})
      const candidate={schemaVersion:1,strategy,route:{models:job.policy.allowedModels,tools:[],maxConcurrency:2,tdd:true},taskTypes:[],
        estimates:{wallTimeMs:route.wallTimeMs,costMicrounits:cost,quality:null,currency:'USD',source:job.forecastSource}}
      const feedback=advanceFeedback(bank,{manifest:{schemaVersion:1,experimentId:route.id,mode:'frozen',splits:{train:[],validation:[],test:[job.scenario.request.taskId]}},
        policy:job.policy,cutoff:'2000-01-01T00:00:00.000Z'})
      result=await runAdaptiveAttempt({...job.scenario,bank,attemptId,feedback,candidates:[candidate],
        bindings:[{schemaVersion:1,armId:armId(candidate),plan,greenTaskId:plan.tasks.find(t=>t.id==='refactor').dependsOn[0],refactorTaskId:'refactor'}],
        templateSelection:planned.selection??{schemaVersion:1,method:job.method},componentTaskIds:plan.tasks.filter(t=>t.id.startsWith('implement-')).map(t=>t.id),
        guardedCallsOnly:true,createRuntime:runtime,evaluationDockerImage,allowLlm:true,signal})
    }
    const report={schemaVersion:1,method:job.method,selectionWallTimeMs,attempt:result.attempt,
      acceptancePassed:['succeeded','inconclusive'].includes(result.attempt.state)&&result.attempt.evaluation?.provenance?.source==='independent-node-evaluator'&&result.attempt.evaluation.correctness==='passed'}
    await writeFile(join(out,'report.json'),JSON.stringify(report,null,2),{mode:0o600})
    return report
  }catch(error){
    await writeFile(join(out,'run-error.json'),JSON.stringify({schemaVersion:1,state:signal?.aborted?'cancelled':'failed',message:error.message},null,2),{mode:0o600})
    throw error
  }finally{bank.close()}
}
