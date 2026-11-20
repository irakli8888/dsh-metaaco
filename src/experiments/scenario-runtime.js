import { createDeepSeekAdapter } from '../adapters/harness/deepseek.js'
import { validateFiles, validateSnapshot } from '../evaluation/runner.js'
import { createOutputBudget } from './output-budget.js'
import { createTextRuntime } from '../../examples/offline-runtime.js'

export function skillDescriptor(skill, componentId=null) {
  return JSON.stringify({kind:'scenario-skill-v1',skill,componentId})
}

export function validateArchitecture(value, scenario, componentIds) {
  if(value?.schemaVersion!==1||!Array.isArray(value.components)||value.components.length!==componentIds.length) throw Error('Invalid architecture schema')
  const owners=new Set(),ids=new Set()
  const forbidden=new Set(['architecture.json',...scenario.request.testSpec.suites.flatMap(s=>Object.keys(s.files))])
  for(const component of value.components) {
    if(!componentIds.includes(component.id)||ids.has(component.id)||typeof component.contract!=='string'||!component.contract.trim()||component.contract.length>16000||!Array.isArray(component.files)||!component.files.length) throw Error('Invalid architecture component')
    ids.add(component.id)
    for(const path of component.files) {
      if(typeof path!=='string'||!path.endsWith('.cjs')||path.includes('.test.')||forbidden.has(path)||owners.has(path)) throw Error('Invalid or overlapping architecture file ownership')
      validateFiles({[path]:''})
      owners.add(path)
    }
  }
  for(const path of Object.keys(scenario.baseSnapshot.files).filter(path=>path.endsWith('.cjs'))) {
    if(!owners.has(path)) throw Error('Architecture omits an existing source file')
  }
  return value
}

function descriptor(envelope) {
  try {const value=JSON.parse(envelope.task);if(value.kind==='scenario-skill-v1')return value}catch{}
  return {skill:'implement',componentId:null}
}

function architectureFrom(envelope,scenario,componentIds) {
  const parent=envelope.artifacts.find(a=>a.producer==='design')
  if(!parent) throw Error('Component requires an architecture artifact')
  const snapshot=JSON.parse(parent.content)
  validateSnapshot(snapshot)
  return validateArchitecture(JSON.parse(snapshot.files['architecture.json']),scenario,componentIds)
}

export function scenarioPrompt(envelope,scenario,componentIds) {
  const role=descriptor(envelope)
  let instruction
  if(role.skill==='design') instruction=`Choose the internal architecture yourself. Return only architecture.json in files. Its JSON must have schemaVersion:1 and components:[{id,files,contract}]. Use exactly component ids ${JSON.stringify(componentIds)}. Choose disjoint .cjs file ownership covering existing source files. Each contract describes responsibilities and interfaces agreed before parallel coding. Do not implement source files in this step.`
  else if(role.skill==='component') {
    const architecture=architectureFrom(envelope,scenario,componentIds)
    const assignment=architecture.components.find(c=>c.id===role.componentId)
    if(!assignment)throw Error('Unknown component assignment')
    instruction=`Implement your assigned component under this model-generated architecture: ${JSON.stringify(architecture)}. Your component is ${role.componentId}. Return exactly these files: ${JSON.stringify(assignment.files)}. Do not return any other files.`
  } else if(role.skill==='analyze') instruction='Analyze requirements and edge cases. Return analysis.md only.'
  else if(role.skill==='review') instruction='Review the implementation against the public specification. Return review.md only.'
  else if(role.skill==='write-tests') instruction='Suggest additional checks in test-plan.md. Do not modify evaluator tests.'
  else if(role.skill==='integrate') instruction='Integrate all supplied component outputs using their architecture artifact and public requirements. Return a complete production snapshot including unchanged project files. Resolve interface inconsistencies.'
  else if(role.skill==='refactor') instruction='Refactor while preserving verified behavior. Return a complete production snapshot including unchanged project files.'
  else instruction='Implement the task. Choose the internal architecture yourself. Return the complete production snapshot including unchanged project files.'
  return [
    'Complete this coding task. Return only a JSON object with exactly two keys: revision and files.',
    'revision must be a nonempty string. files maps relative paths to full contents. Do not include evaluator tests.',
    scenario.request.description,instruction,
    `Immutable project files: ${JSON.stringify(Object.keys(scenario.baseSnapshot.files).filter(path=>path.endsWith('.md')))}. Copy these contents verbatim from the existing project; do not summarize, reformat, or rewrite the specification.`,
    'Parent artifacts:',JSON.stringify(envelope.artifacts),
  ].join('\n')
}

export function validateScenarioOutput(output,envelope,scenario,componentIds) {
  const snapshot=JSON.parse(output)
  validateSnapshot(snapshot)
  const role=descriptor(envelope)
  const paths=Object.keys(snapshot.files)
  const protectedTests=new Set(scenario.request.testSpec.suites.flatMap(s=>Object.keys(s.files)))
  if(paths.some(path=>protectedTests.has(path)||path.includes('.test.')))throw Error('Model output contains control tests')
  if(role.skill==='design') {
    if(paths.length!==1||paths[0]!=='architecture.json')throw Error('Design must return only architecture.json')
    validateArchitecture(JSON.parse(snapshot.files['architecture.json']),scenario,componentIds)
  }else if(role.skill==='component') {
    const architecture=architectureFrom(envelope,scenario,componentIds)
    const assignment=architecture.components.find(c=>c.id===role.componentId)
    if(!assignment||JSON.stringify(paths.sort())!==JSON.stringify([...assignment.files].sort()))throw Error('Component violated architecture ownership')
  }else if(['implement','integrate','refactor'].includes(role.skill)) {
    for(const [path,content]of Object.entries(scenario.baseSnapshot.files)) {
      if(!Object.hasOwn(snapshot.files,path))throw Error('Final snapshot omitted an existing project file')
      if(path.endsWith('.md')&&snapshot.files[path]!==content)throw Error('Final snapshot changed the pinned specification')
    }
  }
  return output
}

export async function createScenarioRuntime({guardAdapter,signal,key,fetchImpl,scenario,componentIds,limits,bank,attemptId}) {
  const outputBudget=createOutputBudget(limits)
  let artifactIndex=0
  const save=(label,value)=>{if(bank&&attemptId)bank.attachArtifact(attemptId,label,bank.putArtifact(Buffer.from(value)))}
  const runtime=await createTextRuntime({guardAdapter,signal,provider:'deepseek',
    createAdapter:()=>{
      const {adapter,quote}=createDeepSeekAdapter({key,fetchImpl,maxTokens:limits.maxTokens,
        maxInputBytes:limits.maxInputBytes,requestTimeoutMs:limits.requestTimeoutMs})
      return {adapter:outputBudget.wrap(adapter),quote}
    },
    promptFor:envelope=>{
      const prompt=scenarioPrompt(envelope,scenario,componentIds)
      save(`scenario-prompt-${++artifactIndex}`,prompt)
      return prompt
    },
    outputFor:(output,envelope)=>{
      save(`scenario-output-${++artifactIndex}`,output)
      return validateScenarioOutput(output,envelope,scenario,componentIds)
    },
  })
  return {...runtime,async dispose(){
    try{await runtime.dispose()}finally{save('scenario-output-budget',JSON.stringify(outputBudget.snapshot()))}
  }}
}
