import {parseArgs} from 'node:util'
import {readFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {learningTasks} from './learning-tasks/index.js'
import {prepareScenarioJob,planScenarioJob} from '../src/experiments/scenario-study.js'
import {runScenarioTraining,trainingIntervention} from '../src/experiments/scenario-training.js'
import {seededIndex} from '../src/selector/index.js'
const {values}=parseArgs({options:{execute:{type:'boolean',default:false},out:{type:'string'},'budget-microunits':{type:'string'},'docker-image':{type:'string'},'key-file':{type:'string'},'source-commit':{type:'string'}}})
const tasks=await learningTasks(),seeds=[7,11],rounds=4,budget=Number(values['budget-microunits']??5000000)
if(!Number.isSafeInteger(budget)||budget<1||budget>5000000)throw Error('Series budget must be at most authorized 5000000 microunits')
if(!values.execute){
 const previews=[]
 for(const task of tasks)for(const seed of seeds)for(const round of [0,1]){
  const job=prepareScenarioJob(task,{seed:seededIndex(seed,`${task.request.taskId}/${round}`,0xffffffff)})
  job.policy.maxCostMicrounits=budget
  const intervention=trainingIntervention(round,seed,seeds)
  const planned=await planScenarioJob(job,{training:{...intervention,exploreTraining:true}})
  previews.push({taskId:task.request.taskId,seed,round,intervention,plan:planned.plan,selection:planned.selection})
 }
 console.log(JSON.stringify({study:'multitask-training-v1',paidCalls:0,seeds,rounds,maximumAttempts:24,budgetMicrounits:budget,
  split:{train:tasks.map(t=>({id:t.request.taskId,hashes:t.hashes})),validation:[],test:[]},initialStrata:previews,
  laterRounds:'Unrestricted MetaACO with task/seed-scoped completed experience and one observed positive warm seed'},null,2))
}else{
 if(!values.out||!values['budget-microunits']||!/^sha256:[a-f0-9]{64}$/.test(values['docker-image']??''))throw Error('Execute requires fresh --out, explicit budget and pinned Docker image')
 const root=fileURLToPath(new URL('../',import.meta.url))
 const commit=values['source-commit']??execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim()
 if(!/^[a-f0-9]{40}$/.test(commit))throw Error('Full source commit required')
 let archiveSha256=null
 try{archiveSha256=createHash('sha256').update(await readFile(new URL('../source.tar',import.meta.url))).digest('hex')}catch{}
 const provenance={commit,archiveSha256,node:process.version,python:execFileSync('python3',['--version'],{encoding:'utf8'}).trim(),
  packages:Object.fromEntries(await Promise.all(['@deepseek-ai/cordis','@deepseek-ai/dsh-workflow-ptc','@deepseek-ai/dsh-agent'].map(async name=>[name,JSON.parse(await readFile(new URL('../node_modules/'+name+'/package.json',import.meta.url),'utf8')).version])))}
 const key=process.env.DEEPSEEK_API_KEY??(values['key-file']?(await readFile(values['key-file'],'utf8')).trim():null)
 if(!key)throw Error('API key required')
 const controller=new AbortController(),stop=()=>controller.abort(new Error('Interrupted by operator'))
 process.once('SIGINT',stop);process.once('SIGTERM',stop)
 try{const result=await runScenarioTraining({tasks,seeds,rounds,out:resolve(values.out),budgetMicrounits:budget,evaluationDockerImage:values['docker-image'],key,allowLlm:true,signal:controller.signal,provenance});console.log(JSON.stringify(result,null,2))}
 finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop)}
}
