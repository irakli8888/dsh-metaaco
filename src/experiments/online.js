import { mkdir, open, writeFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { performance } from 'node:perf_hooks'
import { StrategyBank } from '../bank/index.js'
import { advanceFeedback, readFeedback } from '../feedback/index.js'
import { runAdaptiveAttempt } from '../orchestration/index.js'
import { armId, hash, validatePolicy } from '../selector/contracts.js'
import { seededIndex } from '../selector/index.js'
import { scoreContext } from '../selector/linucb.js'
import { validateDag } from '../execution/contracts.js'
import { validateRequest } from '../contracts/bank.js'
import { validateSnapshot, validateSpec } from '../evaluation/runner.js'
import { EXPERIMENT_MODES, summarizeExperiment } from './index.js'

export function validateStudyConfig(config) {
  if (config.schemaVersion !== 1 || !/^[a-z0-9-]+$/.test(config.studyId)) throw Error('Invalid online study')
  validateRequest(config.task.request); validateSpec(config.task.request.testSpec); validateSnapshot(config.task.baseSnapshot)
  validatePolicy(config.policy)
  if (config.task.baseSnapshot.revision !== config.task.request.baseCommit) throw Error('Base snapshot mismatch')
  if (config.policy.maxWallTimeMs !== null && (!Number.isSafeInteger(config.policy.maxWallTimeMs) || config.policy.maxWallTimeMs < 1 || config.policy.maxWallTimeMs > 2147483647)) throw Error('Invalid attempt deadline')
  if (JSON.stringify(config.trainTaskIds) !== JSON.stringify([config.task.request.taskId])) throw Error('Online study requires one explicit train task')
  if (!Number.isSafeInteger(config.attemptsPerCell) || config.attemptsPerCell < 1 || config.attemptsPerCell > 100) throw Error('Invalid attempt count')
  if (!Array.isArray(config.seeds) || !config.seeds.length || config.seeds.length > 32 || new Set(config.seeds).size !== config.seeds.length) throw Error('Invalid seeds')
  config.seeds.forEach(seed => seededIndex(seed, 'validation', 1))
  if (!Array.isArray(config.modes) || !config.modes.length || new Set(config.modes).size !== config.modes.length || config.modes.some(m => !EXPERIMENT_MODES.includes(m))) throw Error('Invalid modes')
  if (!config.routes.length || new Set(config.routes.map(r => r.id)).size !== config.routes.length) throw Error('Invalid routes')
  for (const route of config.routes) {
    validateDag(route.plan)
    if (!/^[a-z0-9-]+$/.test(route.id) || !Number.isSafeInteger(route.costMicrounits) || route.costMicrounits < 0 || !Number.isFinite(route.wallTimeMs) || route.wallTimeMs <= 0) throw Error('Invalid route estimates')
    const refactor = route.plan.tasks.find(t => t.id === route.refactorTaskId)
    if (!route.plan.tasks.some(t => t.id === route.greenTaskId) || !refactor?.dependsOn.includes(route.greenTaskId)) throw Error('Invalid TDD route')
    if (route.plan.resources.agentSlots > config.policy.maxConcurrency || route.plan.tasks.some(t => !t.model || !config.policy.allowedModels.includes(`${t.model.provider}/${t.model.model}`))) throw Error('Route outside policy')
    if (config.policy.maxCostMicrounits !== null && route.costMicrounits > config.policy.maxCostMicrounits) throw Error('Route cost outside policy')
  }
  if (!config.routes.some(r => r.id === config.fixedRouteId)) throw Error('Missing fixed route')
  if (!config.runtimeConfig || typeof config.runtimeConfig !== 'object') throw Error('Pinned runtime configuration required')
}

// This same-task research policy does not change the production selector's exclusion rules.
export function chooseOnlineRoute({ mode, routes, fixedRouteId, seed, round, history, alpha = 0.2, lambda = 1 }) {
  const ordered = [...routes].sort((a,b) => a.id.localeCompare(b.id, 'en'))
  if (mode === 'fixed') return ordered.find(r => r.id === fixedRouteId)
  if (mode === 'random') return ordered[seededIndex(seed, `round/${round}`, ordered.length)]
  if (mode === 'cheapest') return ordered.reduce((a,b) => b.costMicrounits < a.costMicrounits ? b : a)
  if (!['historical-best','contextual-bandit'].includes(mode)) throw Error('MetaACO requires the trusted skill search')
  let best = ordered[0], bestScore = -Infinity
  for (const route of ordered) {
    const observations = history.filter(row => row.routeId === route.id && row.reward !== null)
    const score = mode === 'historical-best'
      ? observations.length ? observations.reduce((n,row) => n + row.reward,0) / observations.length : -Infinity
      : scoreContext([1], observations.map(row => ({context:[1],reward:row.reward})), {alpha,lambda}).score
    if (score > bestScore) { best = route; bestScore = score }
  }
  return best
}

function reward(record) {
  if (record.state === 'succeeded' && record.evaluationVerified && record.evaluation?.status === 'success') return 1
  return ['failed','timeout','cancelled','interrupted'].includes(record.state) ? -1 : null
}

export function summarizeOnlineStudy(rows) {
  const keys = [...new Set(rows.map(row => `${row.mode}/${row.seed}`))]
  const trajectories = keys.map(key => {
    const series = rows.filter(row => `${row.mode}/${row.seed}` === key).sort((a,b) => a.round-b.round)
    const first = series.findIndex(row => row.verifiedSuccess)
    const until = first < 0 ? series : series.slice(0,first+1)
    const completeCost = subset => subset.every(row => row.costMicrounits !== null)
      ? subset.reduce((n,row) => n+row.costMicrounits,0) : null
    return {mode:series[0].mode,seed:series[0].seed,observedAttempts:series.length,
      firstSuccessAttempt:first < 0 ? null : series[first].round+1,censored:first < 0,
      timeToFirstOrCensorMs:until.reduce((n,row) => n+row.totalWallTimeMs,0),
      costToFirstOrCensorMicrounits:completeCost(until),
      knownCostToFirstOrCensorMicrounits:until.reduce((n,row)=>n+row.knownCostMicrounits,0),
      totalCostMicrounits:completeCost(series),modelCalls:series.reduce((n,row)=>n+(row.modelCalls??0),0),uniqueRoutes:new Set(series.map(row=>row.routeId)).size}
  })
  return {modes:summarizeExperiment(rows),trajectories,rows}
}

/** Fresh output directory owns every bank. No injected bank, paid resume or automatic retry. */
export async function runOnlineStudy({out, config: input, createRuntime, search, allowLlm = false, signal}) {
  if (allowLlm !== true) throw Error('Explicit allowLlm: true required')
  signal?.throwIfAborted()
  if (!isAbsolute(out)) throw Error('Absolute output path required')
  const config = structuredClone(input)
  validateStudyConfig(config)
  if (typeof createRuntime !== 'function') throw Error('Trusted runtime factory required')
  if (config.modes.some(m => m.startsWith('metaaco-')) && typeof search !== 'function') throw Error('Trusted skill search required')
  await mkdir(out, {mode:0o700})
  const manifest = {schemaVersion:1,config,configHash:hash(config),node:process.version,startedAt:new Date().toISOString()}
  await writeFile(join(out,'manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx',mode:0o600})
  const journal = await open(join(out,'journal.jsonl'),'wx',0o600)
  const append = async row => {await journal.writeFile(JSON.stringify(row)+'\n');await journal.sync()}
  const cells = [], rows = []
  try {
    for (const mode of config.modes) for (const seed of config.seeds) {
      const dataDir = join(out,mode,String(seed))
      const bank = new StrategyBank({dataDir})
      const cell = {mode,seed,bank,feedback:null}
      cells.push(cell)
      const manifest = {schemaVersion:1,experimentId:`${config.studyId}/${mode}/${seed}`,mode:'online-train',splits:{train:config.trainTaskIds,validation:[],test:[]}}
      cell.feedback = advanceFeedback(bank,{manifest,policy:config.policy,cutoff:'2000-01-01T00:00:00.000Z'})
      if (readFeedback(bank,cell.feedback).snapshot.records.length) throw Error('Initial history is not empty')
      await append({type:'empty-history',mode,seed,feedback:cell.feedback})
    }
    for (let round=0;round<config.attemptsPerCell;round++) {
      const order = [...cells]
      for (let i=order.length-1;i>0;i--) {
        const j=seededIndex(config.seeds[0],`round/${round}/shuffle/${i}`,i+1)
        ;[order[i],order[j]]=[order[j],order[i]]
      }
      for (const cell of order) {
        signal?.throwIfAborted()
        const {bank,mode,seed} = cell
        const started=performance.now(), attemptId=`round-${round}`
        const deadline = config.policy.maxWallTimeMs === null ? null : AbortSignal.timeout(config.policy.maxWallTimeMs)
        const attemptSignal = signal && deadline ? AbortSignal.any([signal, deadline]) : signal ?? deadline ?? undefined
        const snapshot = readFeedback(bank,cell.feedback).snapshot
        if (snapshot.records.length !== round) throw Error('History count differs from completed rounds')
        const history = snapshot.records.map(record => {
          const stored = bank.getAttempt(record.attemptId)
          return {attemptId:record.attemptId,routeId:stored.strategy.strategyId,reward:reward(record)}
        })
        await append({type:'start',mode,seed,round,attemptId,feedback:cell.feedback,historyCount:history.length})
        const decision = mode.startsWith('metaaco-')
          ? await search({mode,seed,round,history:mode==='metaaco-with-bank'?structuredClone(history):[],config:structuredClone(config),signal:attemptSignal})
          : {routeId:chooseOnlineRoute({mode,routes:config.routes,fixedRouteId:config.fixedRouteId,seed,round,history,alpha:config.policy.alpha,lambda:config.policy.lambda}).id}
        const route = config.routes.find(r => r.id === decision.routeId)
        if (!route) throw Error('Selected route is outside pinned catalog')
        let plan = route.plan
        if (decision.dispatchOrder) {
          const tasks = new Map(plan.tasks.map(task => [task.id, task]))
          if (decision.dispatchOrder.length !== tasks.size || new Set(decision.dispatchOrder).size !== tasks.size || decision.dispatchOrder.some(id => !tasks.has(id))) {
            throw Error('Invalid search dispatch order')
          }
          plan = validateDag({...plan, tasks: decision.dispatchOrder.map(id => tasks.get(id))})
        }
        const strategy = bank.register({schemaVersion:1,strategyId:route.id,version:1,provenance:{source:config.studyId},workflow:{name:route.id,description:'Online route',stages:[{title:'Code',agents:[{id:'coder',prompt:'Implement'}]}]}})
        const candidate = {schemaVersion:1,strategy,route:{models:[...new Set(route.plan.tasks.map(t=>`${t.model.provider}/${t.model.model}`))],tools:[],maxConcurrency:route.plan.resources.agentSlots,tdd:true},taskTypes:[],estimates:{wallTimeMs:route.wallTimeMs,costMicrounits:route.costMicrounits,quality:null,currency:config.policy.currency,source:'Pinned cold-start forecasts'}}
        const result = await runAdaptiveAttempt({...config.task,bank,feedback:cell.feedback,attemptId,candidates:[candidate],
          bindings:[{schemaVersion:1,armId:armId(candidate),plan,greenTaskId:route.greenTaskId,refactorTaskId:route.refactorTaskId}],
          templateSelection:{schemaVersion:1,method:mode,round,history,decision},
          componentTaskIds:route.plan.tasks.filter(t=>t.id.startsWith('implement-')).map(t=>t.id),
          evaluationDockerImage:config.evaluationDockerImage,guardedCallsOnly:true,allowLlm:true,signal:attemptSignal,
          createRuntime:args=>createRuntime({...args,mode,seed,round,runtimeConfig:structuredClone(config.runtimeConfig)})})
        const attempt=result.attempt, metrics=attempt.outcome, cost=metrics?.calculated?.costs.find(c=>c.currency===config.policy.currency)
        const row={mode,seed,round,attemptId,routeId:route.id,historyCount:history.length,state:attempt.state,
          verifiedSuccess:attempt.state==='succeeded'&&attempt.evaluation?.status==='success',
          totalWallTimeMs:performance.now()-started,costMicrounits:cost?.microunits??null,knownCostMicrounits:cost?.knownMicrounits??0,
          modelCalls:metrics?.measured?.observedCallCount??0,feedback:result.feedback,feedbackError:result.feedbackError}
        rows.push(row); await append({type:'result',row})
        await writeFile(join(out,'summary.json'),JSON.stringify(summarizeOnlineStudy(rows),null,2),{mode:0o600})
        if(result.feedbackError) throw Error(`Feedback update failed: ${result.feedbackError}`)
        cell.feedback=result.feedback
        const events=bank.getEvents(attemptId)
        const text=JSON.stringify(events.filter(e=>e.kind==='dag-finish-v1'||e.kind==='orchestration-error-v1'))
        if (/DeepSeek HTTP (401|402|403|429)|Baseline regression gate|Expected RED gate|spawn.*ENOENT|Cannot connect to the Docker daemon/.test(text)) throw Error('Study stopped for API or evaluator infrastructure failure')
        if (attempt.state==='inconclusive'||attempt.state==='interrupted') throw Error('Study stopped on inconclusive infrastructure outcome')
      }
    }
    await append({type:'completed',count:rows.length})
    return {rows,summary:summarizeOnlineStudy(rows)}
  } catch(error) {
    await append({type:'stopped',reason:error.message})
    throw error
  } finally {
    for(const cell of cells) cell.bank.close()
    await journal.close()
  }
}
