import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { seededIndex } from '../selector/index.js'

export const routeIdentity = plan => JSON.stringify(plan.tasks.map(task => [
  task.id, task.model.provider, task.model.model, [...task.dependsOn].sort(),
]).sort((a,b) => a[0].localeCompare(b[0], 'en')))

/** Frozen input from the online runner, never a live or external Bank. */
export async function searchOnlineSkills({ mode, seed, round, history, config, signal }) {
  const byId = new Map(config.routes.map(route => [route.id, route]))
  const stats = new Map()
  for (const row of history) {
    if (row.reward === null) continue
    if (!byId.has(row.routeId)) throw Error('History contains route outside catalog')
    const entry = stats.get(row.routeId) ?? {route: JSON.parse(routeIdentity(byId.get(row.routeId).plan)), attempts:0, successes:0}
    entry.attempts++
    if(row.reward===1) entry.successes++
    stats.set(row.routeId,entry)
  }
  if(mode==='metaaco-without-bank' && history.length) throw Error('History forbidden for without-bank mode')
  const directory=await mkdtemp(join(tmpdir(),'online-skills-'))
  try {
    const input=join(directory,'input.json')
    await writeFile(input,JSON.stringify({skills:config.skills,resources:config.routes[0].plan.resources,
      budgetMicrounits:config.policy.maxCostMicrounits,qualityEvidence:[...stats.values()],
      exploreTraining:mode==='metaaco-with-bank',trainingEvidence:[]}),{mode:0o600})
    const solverSeed=seededIndex(seed,`round/${round}/solver`,0xffffffff)
    const {stdout}=await promisify(execFile)('python3',['-B',fileURLToPath(new URL('../../python/skill_decisions.py',import.meta.url)),input,'--seed',String(solverSeed)],{signal,timeout:30000,maxBuffer:4*1024*1024})
    const result=JSON.parse(stdout)
    const route=config.routes.find(route=>routeIdentity(route.plan)===routeIdentity(result.problem.plan))
    if(!route) throw Error('Solver selected route outside pinned catalog')
    return {routeId:route.id,solverSeed,evaluations:result.evaluations,dispatchOrder:result.dispatchOrder,
      exploration:result.exploration??null,trace:result.trace}
  } finally {await rm(directory,{recursive:true,force:true})}
}
