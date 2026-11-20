import { readFile } from 'node:fs/promises'
import { baseSnapshot, contracts, requirements, userBrief } from './task.js'
import { digest } from '../../src/evaluation/runner.js'

export async function webhookScenario() {
  const acceptance = await readFile(new URL('./acceptance.cjs', import.meta.url), 'utf8')
  const regression = await readFile(new URL('./regression.cjs', import.meta.url), 'utf8')
  const expectedRedTests = [...acceptance.matchAll(/^test\('([^']+)'/gm)].map(match => match[1])
  const testSpec = {schemaVersion:1,id:'webhook-retry-v2',acceptanceCriteria:requirements,
    timeoutMs:10000,maxOutputBytes:100000,suites:[
      {id:'target',kind:'target',expectedRedTests,files:{'acceptance.test.cjs':acceptance}},
      {id:'regression',kind:'regression',expectedRedTests:[],files:{'regression.test.cjs':regression}},
    ]}
  return structuredClone({schemaVersion:1,split:'validation-candidate',baseSnapshot,
    request:{schemaVersion:1,taskId:'webhook-retry-v2',repo:'webhook-fixture-v2',baseCommit:baseSnapshot.revision,
      description:[userBrief,'Existing project files:',JSON.stringify(baseSnapshot)].join('\n'),
      testSpec,provenance:{source:'webhook-scenario-v2'}},
    userBrief,
    decomposition:{status:'requires-design-artifact',ownership:'assigned-by-architecture-before-parallel-implementation'},
    rolePrompts:{
      analyze:'Analyze requirements and failure modes. Return analysis.md only.',
      design:'Plan the implementation from the public requirements; propose internal interfaces and disjoint file ownership before parallel implementation. Return architecture.json only, with schemaVersion:1 and components containing id, files and contract.',
      implement:'Implement the full requested change. Return a complete production snapshot with all existing files and any added modules.',
      'implement-component':'Implement the component assigned by the architecture artifact. Follow its agreed interfaces and return only explicitly assigned files.',
      'write-tests':'Propose additional cases in test-plan.md. Mandatory evaluator tests are pinned independently.',
      integrate:'Combine component artifacts using the architecture artifact and public requirements. Resolve issues and return the complete production snapshot including existing project files.',
      review:'Review the assembled implementation against the requirements. Return findings in review.md only.',
      refactor:'Preserve verified behavior and existing exports. Return the complete production snapshot including existing project files.',
    },hashes:{baseSnapshot:digest(baseSnapshot),testSpec:digest(testSpec),contracts:digest(contracts)}})
}
