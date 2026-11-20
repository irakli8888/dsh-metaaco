import { readFile } from 'node:fs/promises'
import {webhookTask} from './task.js'
import { digest } from '../../src/evaluation/runner.js'

export async function webhookScenario({version=2}={}) {
  const {baseSnapshot,contracts,requirements,userBrief}=webhookTask(version)
  const id=`webhook-retry-v${version}`
  const responseContract=version===3?{schemaVersion:2,readOnlyFiles:['README.md']}:undefined
  const acceptance = await readFile(new URL('./acceptance.cjs', import.meta.url), 'utf8')
  const regression = await readFile(new URL('./regression.cjs', import.meta.url), 'utf8')
  const expectedRedTests = [...acceptance.matchAll(/^test\('([^']+)'/gm)].map(match => match[1])
  const testSpec = {schemaVersion:1,id,acceptanceCriteria:requirements,
    timeoutMs:10000,maxOutputBytes:100000,suites:[
      {id:'target',kind:'target',expectedRedTests,files:{'acceptance.test.cjs':acceptance}},
      {id:'regression',kind:'regression',expectedRedTests:[],files:{'regression.test.cjs':regression}},
    ]}
  return structuredClone({schemaVersion:1,split:'validation-candidate',baseSnapshot,
    ...(responseContract?{responseContract}:{}),
    request:{schemaVersion:1,taskId:id,repo:`webhook-fixture-v${version}`,baseCommit:baseSnapshot.revision,
      description:[userBrief,'Existing project files:',JSON.stringify(baseSnapshot)].join('\n'),
      testSpec,provenance:{source:`webhook-scenario-v${version}`}},
    userBrief,
    decomposition:{status:'requires-design-artifact',ownership:'assigned-by-architecture-before-parallel-implementation'},
    rolePrompts:{
      analyze:'Analyze requirements and failure modes. Return analysis.md only.',
      design:version===3?'Choose private interfaces and disjoint ownership; return the version 2 architecture DTO with components directly. The host serializes architecture.json.':'Plan the implementation from the public requirements; propose internal interfaces and disjoint file ownership before parallel implementation. Return architecture.json only, with schemaVersion:1 and components containing id, files and contract.',
      implement:version===3?'Implement the change; return a version 2 files DTO with complete editable source only. The host restores read-only files.':'Implement the full requested change. Return a complete production snapshot with all existing files and any added modules.',
      'implement-component':'Implement the component assigned by the architecture artifact. Follow its agreed interfaces and return only explicitly assigned files.',
      'write-tests':'Propose additional cases in test-plan.md. Mandatory evaluator tests are pinned independently.',
      integrate:version===3?'Integrate components under their architecture; return a version 2 files DTO with complete editable source only. The host restores read-only files.':'Combine component artifacts using the architecture artifact and public requirements. Resolve issues and return the complete production snapshot including existing project files.',
      review:'Review the assembled implementation against the requirements. Return findings in review.md only.',
      refactor:version===3?'Preserve verified behavior and synchronous exports; return a version 2 files DTO with complete editable source only. The host restores read-only files.':'Preserve verified behavior and existing exports. Return the complete production snapshot including existing project files.',
    },hashes:{baseSnapshot:digest(baseSnapshot),testSpec:digest(testSpec),contracts:digest(contracts),...(responseContract?{responseContract:digest(responseContract)}:{})}})
}
