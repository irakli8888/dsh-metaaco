import {fields} from '../contracts/bank.js'
import {validateFiles} from '../evaluation/runner.js'

/** Trusted host configuration; absent means the historical snapshot contract. */
export function responseContractFor(scenario){
  const contract=scenario.responseContract
  if(contract===undefined)return null
  fields(contract,['schemaVersion','readOnlyFiles'],'Response contract')
  if(contract.schemaVersion!==2||!Array.isArray(contract.readOnlyFiles)||new Set(contract.readOnlyFiles).size!==contract.readOnlyFiles.length)throw Error('Unsupported or invalid response contract')
  for(const path of contract.readOnlyFiles){
    if(typeof path!=='string'||!Object.hasOwn(scenario.baseSnapshot.files,path))throw Error('Read-only file must exist in pinned snapshot')
    validateFiles({[path]:scenario.baseSnapshot.files[path]})
  }
  return contract
}

export function responseSchema(skill,componentIds){
  const architecture=skill==='design'
  const properties={schemaVersion:{const:2},kind:{const:architecture?'architecture':'files'},revision:{type:'string',minLength:1}}
  if(architecture)properties.components={type:'array',minItems:componentIds.length,maxItems:componentIds.length,
    items:{type:'object',additionalProperties:false,required:['id','files','contract'],properties:{
      id:{enum:componentIds},files:{type:'array',minItems:1,uniqueItems:true,items:{type:'string'}},contract:{type:'string',minLength:1,maxLength:16000},
    }}}
  else properties.files={type:'object',additionalProperties:{type:'string'}}
  return {type:'object',additionalProperties:false,required:Object.keys(properties),properties}
}

/** Decode the wire DTO, without executing or rewriting generated source. */
export function decodeScenarioResponse(output,skill){
  const value=JSON.parse(output)
  const design=skill==='design'
  // Check discriminator first, so a wrong role cannot masquerade as a file snapshot.
  if(value?.schemaVersion!==2||value.kind!==(design?'architecture':'files'))throw Error('Unexpected response version or kind')
  fields(value,design?['schemaVersion','kind','revision','components']:['schemaVersion','kind','revision','files'],'Scenario response')
  if(design)return {revision:value.revision,files:{'architecture.json':JSON.stringify({schemaVersion:1,components:value.components})}}
  return {revision:value.revision,files:value.files}
}
