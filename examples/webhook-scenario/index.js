import { readFile } from 'node:fs/promises'
import { baseSnapshot, contracts, requirements, componentOwnership } from './task.js'
import { digest } from '../../src/evaluation/runner.js'

export async function webhookScenario() {
  const acceptance = await readFile(new URL('./acceptance.cjs', import.meta.url), 'utf8')
  const regression = await readFile(new URL('./regression.cjs', import.meta.url), 'utf8')
  const expectedRedTests = [...acceptance.matchAll(/^test\('([^']+)'/gm)].map(match => match[1])
  const testSpec = {schemaVersion:1,id:'webhook-retry-v1',acceptanceCriteria:requirements,
    timeoutMs:10000,maxOutputBytes:100000,suites:[
      {id:'target',kind:'target',expectedRedTests,files:{'acceptance.test.cjs':acceptance}},
      {id:'regression',kind:'regression',expectedRedTests:[],files:{'regression.test.cjs':regression}},
    ]}
  return structuredClone({schemaVersion:1,split:'validation-candidate',baseSnapshot,
    request:{schemaVersion:1,taskId:'webhook-retry-v1',repo:'webhook-fixture-v1',baseCommit:baseSnapshot.revision,
      description:[...requirements,'Public module contracts:',JSON.stringify(contracts),'Starting files:',JSON.stringify(baseSnapshot)].join('\n'),
      testSpec,provenance:{source:'webhook-scenario-v1'}},
    componentOwnership,
    rolePrompts:{
      analyze:'Analyze requirements and failure modes. Return analysis.md only.',
      design:'Plan the implementation using the pinned public contracts. Return design.md only.',
      implement:'Implement the full requested change. Return a complete production snapshot with all four source files.',
      'implement-store':'Implement the pinned store contract and state transitions. Return only store.cjs. Other modules are owned by other agents.',
      'implement-api':'Implement routing and validation against the pinned store contract. Return only app.cjs. Other modules are owned by other agents.',
      'implement-delivery':'Implement worker and signature contracts. Return only worker.cjs and signature.cjs. Other modules are owned by other agents.',
      'write-tests':'Propose additional cases in test-plan.md. Mandatory evaluator tests are pinned independently.',
      integrate:'Combine component artifacts using their pinned interfaces. Resolve issues and return the complete four-file production snapshot.',
      review:'Review the assembled implementation against the requirements. Return findings in review.md only.',
      refactor:'Preserve verified behavior and existing exports. Return the complete four-file production snapshot.',
    },hashes:{baseSnapshot:digest(baseSnapshot),testSpec:digest(testSpec),contracts:digest(contracts)}})
}
