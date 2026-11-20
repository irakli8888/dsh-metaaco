import { mkdir, open, writeFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { StrategyBank } from '../bank/index.js'
import { advanceFeedback, readFeedback } from '../feedback/index.js'
import { armId, hash } from '../selector/contracts.js'
import { seededIndex } from '../selector/index.js'
import { runAdaptiveAttempt } from '../orchestration/index.js'
import { validateStudyConfig, chooseOnlineRoute } from './online.js'
import { summarizeExperiment } from './index.js'

const learnedModes = new Set(['historical-best', 'contextual-bandit', 'metaaco-with-bank'])

export async function runFrozenStudy({ out, config: input, experience: source, repeats = 5,
  createRuntime, search, allowLlm = false, signal }) {
  if (allowLlm !== true) throw Error('Explicit allowLlm: true required')
  signal?.throwIfAborted()
  if (!isAbsolute(out)) throw Error('Absolute output path required')
  const config = structuredClone(input)
  const experience = structuredClone(source)
  validateStudyConfig(config)
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw Error('Invalid repeats')
  if (!experience?.history?.length || new Set(experience.history.map(r => r.attemptId)).size !== experience.history.length) throw Error('Invalid frozen history')
  const routeIds = new Set(config.routes.map(r => r.id))
  if (experience.history.some(r => !routeIds.has(r.routeId) || ![1,-1,null].includes(r.reward))) throw Error('History outside pinned catalog')
  if (typeof createRuntime !== 'function' || typeof search !== 'function') throw Error('Trusted runtime and search required')
  const historyHash = hash(experience)
  await mkdir(out, { mode: 0o700 })
  await writeFile(join(out, 'manifest.json'), JSON.stringify({schemaVersion:1, config, experience,
    historyHash, repeats, node:process.version, configHash:hash(config)}, null, 2), {flag:'wx',mode:0o600})
  const file = await open(join(out, 'journal.jsonl'), 'wx', 0o600)
  const append = async entry => { await file.writeFile(JSON.stringify(entry)+'\n'); await file.sync() }
  const cells = [], rows = []
  try {
    // Seal all decisions before any evaluated model output exists.
    for (const mode of config.modes) for (const seed of config.seeds) {
      signal?.throwIfAborted()
      const history = learnedModes.has(mode) ? experience.history : []
      const start = performance.now()
      const decision = mode.startsWith('metaaco-')
        ? await search({mode, seed, round:0, history:structuredClone(history), config:structuredClone(config), signal})
        : {routeId: chooseOnlineRoute({mode, seed, round:0, routes:config.routes,
          fixedRouteId:config.fixedRouteId, history, alpha:0, lambda:1}).id}
      if (decision.exploration !== undefined && decision.exploration !== null) throw Error('Frozen search returned exploration override')
      const route = config.routes.find(r => r.id === decision.routeId)
      if (!route) throw Error('Decision outside catalog')
      const selection = {mode, seed, historyHash: learnedModes.has(mode) ? historyHash : null,
        historyCount:history.length, selectionWallTimeMs:performance.now()-start, decision}
      await append({type:'decision', ...selection})
      cells.push({mode,seed,route,selection})
    }
    const decisions = cells.map(cell => cell.selection)
    const decisionHash = hash(decisions)
    await writeFile(join(out,'decisions.json'),JSON.stringify({historyHash,decisionHash,decisions},null,2),{flag:'wx',mode:0o600})
    for (const cell of cells) {
      const bank = new StrategyBank({dataDir:join(out,cell.mode,String(cell.seed))})
      cell.bank = bank
      cell.feedback = advanceFeedback(bank,{manifest:{schemaVersion:1,experimentId:config.studyId,
        mode:'frozen',splits:{train:[],validation:[],test:[config.task.request.taskId]}},
        policy:config.policy,cutoff:'2000-01-01T00:00:00.000Z'})
    }
    for (let repeat=0;repeat<repeats;repeat++) {
      const order=[...cells]
      for (let i=order.length-1;i>0;i--) {
        const j=seededIndex(config.seeds[0],`frozen/${repeat}/${i}`,i+1)
        ;[order[i],order[j]]=[order[j],order[i]]
      }
      for (const cell of order) {
        signal?.throwIfAborted()
        if (hash(experience)!==historyHash || hash(cells.map(c=>c.selection))!==decisionHash) throw Error('Frozen input changed')
        const {bank,route,mode,seed}=cell
        const attemptId=`repeat-${repeat}`
        await append({type:'start',mode,seed,repeat,attemptId,historyHash})
        const strategy=bank.register({schemaVersion:1,strategyId:route.id,version:1,provenance:{source:config.studyId},
          workflow:{name:route.id,description:'Frozen route',stages:[{title:'Code',agents:[{id:'coder',prompt:'Implement'}]}]}})
        let plan=route.plan
        const dispatch=cell.selection.decision.dispatchOrder
        if(dispatch) {
          const byId=new Map(plan.tasks.map(t=>[t.id,t]))
          if(dispatch.length!==byId.size || new Set(dispatch).size!==byId.size || dispatch.some(id=>!byId.has(id))) throw Error('Invalid dispatch order')
          plan={...plan,tasks:dispatch.map(id=>byId.get(id))}
        }
        const candidate={schemaVersion:1,strategy,route:{models:[...new Set(plan.tasks.map(t=>`${t.model.provider}/${t.model.model}`))],
          tools:[],maxConcurrency:plan.resources.agentSlots,tdd:true},taskTypes:[],
          estimates:{wallTimeMs:route.wallTimeMs,costMicrounits:route.costMicrounits,quality:null,currency:config.policy.currency,source:'Fixed frozen forecasts'}}
        const start=performance.now()
        const result=await runAdaptiveAttempt({...config.task,bank,feedback:cell.feedback,attemptId,candidates:[candidate],
          bindings:[{schemaVersion:1,armId:armId(candidate),plan,greenTaskId:route.greenTaskId,refactorTaskId:route.refactorTaskId}],
          templateSelection:{schemaVersion:1,historyHash,decisionHash,selection:cell.selection,repeat},
          componentTaskIds:plan.tasks.filter(t=>t.id.startsWith('implement-')).map(t=>t.id),
          evaluationDockerImage:config.evaluationDockerImage,guardedCallsOnly:true,allowLlm:true,signal,
          createRuntime:args=>createRuntime({...args,mode,seed,repeat,runtimeConfig:structuredClone(config.runtimeConfig)})})
        const attempt=result.attempt
        const cost=attempt.outcome?.calculated?.costs.find(c=>c.currency===config.policy.currency)
        const row={mode,seed,repeat,attemptId,routeId:route.id,state:attempt.state,
          verifiedSuccess:attempt.state==='succeeded'&&attempt.evaluation?.status==='success',
          totalWallTimeMs:performance.now()-start,costMicrounits:cost?.microunits??null,
          knownCostMicrounits:cost?.knownMicrounits??0,modelCalls:attempt.outcome?.measured?.observedCallCount??0,
          historyHash:cell.selection.historyHash,feedback:result.feedback}
        rows.push(row)
        await append({type:'result',row})
        await writeFile(join(out,'summary.json'),JSON.stringify({historyHash,decisionHash,modes:summarizeExperiment(rows),rows},null,2),{mode:0o600})
        if(result.feedbackError || hash(result.feedback)!==hash(cell.feedback) || readFeedback(bank,cell.feedback).snapshot.records.length) throw Error('Evaluation contaminated frozen history')
        const failure=JSON.stringify(bank.getEvents(attemptId).filter(e=>['dag-finish-v1','orchestration-error-v1'].includes(e.kind)))
        if(['inconclusive','interrupted'].includes(attempt.state)||/DeepSeek HTTP (401|402|403|429)|Baseline regression gate|Expected RED gate|spawn.*ENOENT|Cannot connect to the Docker daemon/.test(failure)) throw Error('Frozen study stopped for infrastructure error')
      }
    }
    await append({type:'completed',count:rows.length,historyHash,decisionHash})
    return {rows,historyHash,decisionHash}
  } catch(error) {
    await append({type:'stopped',reason:error.message})
    throw error
  } finally {
    for(const cell of cells) cell.bank?.close()
    await file.close()
  }
}
