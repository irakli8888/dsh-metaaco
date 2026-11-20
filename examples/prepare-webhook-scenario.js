import {parseArgs} from 'node:util'
import {writeFile} from 'node:fs/promises'
import {webhookScenario} from './webhook-scenario/index.js'
const {values}=parseArgs({options:{out:{type:'string'}}})
const scenario=await webhookScenario()
if(values.out)await writeFile(values.out,JSON.stringify(scenario,null,2),{flag:'wx',mode:0o600})
console.log(JSON.stringify({taskId:scenario.request.taskId,sourceFiles:Object.keys(scenario.baseSnapshot.files),
  acceptanceTests:scenario.request.testSpec.suites[0].expectedRedTests.length,hashes:scenario.hashes,
  componentOwnership:scenario.componentOwnership,paidCalls:0,output:values.out??null},null,2))
