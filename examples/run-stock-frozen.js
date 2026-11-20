import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { createStockStudyConfig } from './run-stock-cold-start.js'
import { createDeepSeekRuntime } from './deepseek-runtime.js'
import { loadFrozenExperience } from '../src/experiments/frozen-source.js'
import { runFrozenStudy } from '../src/experiments/frozen-online.js'
import { searchFrozenSkills } from '../src/experiments/skill-search.js'
import { hash } from '../src/selector/contracts.js'

const {values}=parseArgs({options:{execute:{type:'boolean'},source:{type:'string'},out:{type:'string'},preflight:{type:'boolean'}}})
if(!values.source) throw Error('Supply --source with the completed cold-start study directory')
const audit=JSON.parse(await readFile(new URL('../docs/research/data/cold-start-audit.json',import.meta.url),'utf8'))
const {sourceConfig,...experience}=await loadFrozenExperience(values.source,audit)
const {config}=await createStockStudyConfig()
for(const key of ['routes','skills','task','evaluationDockerImage']) {
  if(hash(config[key])!==hash(sourceConfig[key])) throw Error(`Frozen configuration differs from training: ${key}`)
}
config.studyId=values.preflight?'stock-frozen-preflight-v1':'stock-frozen-exploitation-v1'
config.policy={...config.policy,alpha:0,revision:'stock-frozen-exploitation-v1'}
if(values.preflight) config.seeds=[7]
config.runtimeConfig={...config.runtimeConfig,exploration:'disabled-after-search',contextualFeatures:'intercept-only; alpha=0',
  commonHistoryHash:hash(experience),sourceConfigHash:experience.sourceConfigHash}
const repeats=values.preflight?1:5
if(!values.execute) console.log(JSON.stringify({studyId:config.studyId,historyHash:hash(experience),historyCount:experience.history.length,
  decisions:config.modes.length*config.seeds.length,maximumAttempts:config.modes.length*config.seeds.length*repeats,apiCalls:0},null,2))
else {
  if(!values.out||!process.env.DEEPSEEK_API_KEY?.trim()) throw Error('Provide fresh --out and DEEPSEEK_API_KEY')
  const result=await runFrozenStudy({out:values.out,config,experience,repeats,allowLlm:true,search:searchFrozenSkills,
    createRuntime:args=>createDeepSeekRuntime({...args,key:process.env.DEEPSEEK_API_KEY})})
  console.log(JSON.stringify({count:result.rows.length,historyHash:result.historyHash,decisionHash:result.decisionHash}))
}
