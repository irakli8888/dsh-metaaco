import { parseArgs } from 'node:util'
import { readFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runOnlineStudy } from '../src/experiments/online.js'
import { searchOnlineSkills } from '../src/experiments/skill-search.js'
import { coldStartProtocol, validateColdStartProtocol } from './cold-start-protocol.js'
import { task, models, catalog, prompts } from './stock-route-catalog.js'
import { createDeepSeekRuntime } from './deepseek-runtime.js'

const {values}=parseArgs({options:{execute:{type:'boolean'},out:{type:'string'}}})
const design=coldStartProtocol()
const preview=validateColdStartProtocol(design)
const routeCost=plan=>plan.tasks.reduce((n,t)=>n+(t.model.model===models[0]?301229:1324056),0)
const routes=catalog.map(({plan,green},index)=>({id:`route-${String(index+1).padStart(4,'0')}`,plan,
  greenTaskId:green,refactorTaskId:'refactor',costMicrounits:routeCost(plan),
  wallTimeMs:plan.tasks.reduce((n,t)=>n+(t.model.model===models[0]?4000:8000),0)}))
const skills=Object.fromEntries(Object.entries(prompts).map(([id,prompt])=>[id,models.map((model,index)=>({model:{provider:'deepseek',model},prompt,seconds:index?8:4,costMicrounits:index?1324056:301229}))]))
const root=fileURLToPath(new URL('../',import.meta.url))
async function hashes(directory,prefix='') {
  const result={}
  for(const item of await readdir(root+directory,{withFileTypes:true})) {
    if(item.isDirectory()&&item.name!=='__pycache__') Object.assign(result,await hashes(directory+'/'+item.name,prefix+item.name+'/'))
    if(item.isFile()&&/\.(js|py|json|yaml|md)$/.test(item.name)) result[prefix+item.name]=createHash('sha256').update(await readFile(root+directory+'/'+item.name)).digest('hex')
  }
  return result
}
function sourceCommit() {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim() }
  catch {
    const revision = process.env.METAACO_SOURCE_COMMIT
    if (!/^[a-f0-9]{40}$/.test(revision ?? '')) throw Error('An exported tree requires METAACO_SOURCE_COMMIT with its full source commit')
    return revision
  }
}
const config={schemaVersion:1,studyId:'stock-cold-start-online-v1',task,trainTaskIds:[task.request.taskId],
  modes:design.modes,seeds:design.seeds,attemptsPerCell:design.attemptsPerCell,fixedRouteId:'route-0001',routes,skills,
  evaluationDockerImage:design.dockerImage,
  policy:{schemaVersion:1,revision:'cold-online-v1',alpha:0.2,lambda:1,weights:{quality:1,time:0,cost:0},
    normalization:{wallTimeMs:120000,costMicrounits:1000000},currency:'USD',allowedModels:models.map(m=>'deepseek/'+m),
    allowedTools:[],maxConcurrency:2,maxWallTimeMs:120000,maxCostMicrounits:11916504,minQuality:null},
  runtimeConfig:{source:'createDeepSeekRuntime',designHash:preview.sha256,
    commit:sourceCommit(),
    files:{src:await hashes('src'),python:await hashes('python'),examples:await hashes('examples')},
    reward:'verified-success=1; failed/timeout/cancelled/interrupted=-1; inconclusive=null',
    contextualFeatures:'intercept-only, one fixed task',exploration:'least-observed-among-visited',
    initialForecasts:'Flash=4s, Pro=8s; technical cost reservations, not measured prices',
    seriesLimitMicrounits:null}}
if(!values.execute) console.log(JSON.stringify({...preview,implementation:'online-v1',maximumModelCalls:700*8,readyForPaidExecution:false,runnerImplemented:true,requiresLivePreflight:true},null,2))
else {
  if(!values.out||!process.env.DEEPSEEK_API_KEY?.trim()) throw Error('Provide a fresh output path and DEEPSEEK_API_KEY')
  const result=await runOnlineStudy({out:values.out,config,allowLlm:true,search:searchOnlineSkills,
    createRuntime:args=>createDeepSeekRuntime({...args,key:process.env.DEEPSEEK_API_KEY})})
  console.log(JSON.stringify(result.summary,null,2))
}
