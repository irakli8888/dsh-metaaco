import {parseArgs} from 'node:util'
import {readFile,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {webhookScenario} from './webhook-scenario/index.js'
import {prepareScenarioJob,planScenarioJob,runScenarioJob,SCENARIO_METHODS} from '../src/experiments/scenario-study.js'

const {values}=parseArgs({options:{execute:{type:'boolean',default:false},method:{type:'string',default:'metaaco'},
  seed:{type:'string',default:'7'},out:{type:'string'},'docker-image':{type:'string'},'budget-microunits':{type:'string'}}})
const job=prepareScenarioJob(await webhookScenario(),{method:values.method,seed:Number(values.seed)})
if(values['budget-microunits']!==undefined){
  const limit=Number(values['budget-microunits'])
  if(!Number.isSafeInteger(limit)||limit<=0)throw Error('Budget must be a positive safe integer')
  job.policy.maxCostMicrounits=limit
}
if(!SCENARIO_METHODS.includes(values.method))throw Error('Unknown method')
if(!values.execute){
  const planned=await planScenarioJob(job)
  const preview={paidCalls:0,job,planned}
  if(values.out)await writeFile(resolve(values.out),JSON.stringify(preview,null,2),{flag:'wx',mode:0o600})
  console.log(JSON.stringify(preview,null,2))
}else{
  if(!values.out||!/^sha256:[a-f0-9]{64}$/.test(values['docker-image']??''))throw Error('Execute requires a new --out directory and a pinned --docker-image sha256 digest')
  if(!values['budget-microunits'])throw Error('Execute requires an explicit --budget-microunits cap')
  if(!process.env.DEEPSEEK_API_KEY)throw Error('DEEPSEEK_API_KEY is required')
  const files=['package.json','pnpm-lock.yaml','python/skill_decisions.py','python/metaaco_dag.py','src/experiments/scenario-study.js',
    'src/experiments/scenario-runtime.js','src/experiments/output-budget.js','src/adapters/harness/deepseek.js','examples/run-webhook-scenario.js']
  const root=fileURLToPath(new URL('../',import.meta.url))
  let commit=null,dirty=null
  try{
    commit=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()
    dirty=execFileSync('git',['-C',root,'status','--porcelain'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim().length>0
  }catch{} // Installed packages may have no Git metadata; content hashes remain available.
  job.provenance={commit,dirty,python:execFileSync('python3',['--version'],{encoding:'utf8'}).trim(),
    hashes:Object.fromEntries(await Promise.all(files.map(async path=>[path,createHash('sha256').update(await readFile(new URL('../'+path,import.meta.url))).digest('hex')])))}
  const controller=new AbortController()
  const stop=()=>controller.abort(new Error('Interrupted by operator'))
  process.once('SIGINT',stop);process.once('SIGTERM',stop)
  try{
    const report=await runScenarioJob({job,out:resolve(values.out),evaluationDockerImage:values['docker-image'],key:process.env.DEEPSEEK_API_KEY,
      allowLlm:true,signal:controller.signal})
    console.log(JSON.stringify(report,null,2))
  }finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop)}
}
