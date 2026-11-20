import { readFile, access } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { StrategyBank } from '../bank/index.js'
import { readFeedback } from '../feedback/index.js'
import { hash } from '../selector/contracts.js'

export async function loadFrozenExperience(directory, audit) {
  const raw=await readFile(join(directory,'summary.json'))
  if(createHash('sha256').update(raw).digest('hex')!==audit.sourceSummarySha256) throw Error('Source summary changed')
  const manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'))
  if(manifest.configHash!==audit.sourceConfigHash || hash(manifest.config)!==manifest.configHash) throw Error('Source config mismatch')
  const history=[]
  if(audit.cells.length!==35) throw Error('Expected 35 final source snapshots')
  for(const cell of audit.cells) {
    const dataDir=join(directory,cell.mode,String(cell.seed))
    await access(join(dataDir,'bank.sqlite'))
    const bank=new StrategyBank({dataDir})
    try {
      const {snapshot}=readFeedback(bank,cell.feedback)
      if(snapshot.snapshotId!==cell.snapshotId || snapshot.records.length!==20) throw Error('Source snapshot mismatch')
      for(const record of snapshot.records) {
        const attempt=bank.getAttempt(record.attemptId)
        history.push({attemptId:`${cell.mode}/${cell.seed}/${record.attemptId}`,routeId:attempt.strategy.strategyId,
          reward:record.state==='succeeded'&&record.evaluationVerified&&record.evaluation?.status==='success'?1:
            ['failed','timeout','cancelled','interrupted'].includes(record.state)?-1:null})
      }
    } finally {bank.close()}
  }
  history.sort((a,b)=>a.attemptId.localeCompare(b.attemptId,'en'))
  if(history.length!==700||new Set(history.map(r=>r.attemptId)).size!==700) throw Error('Invalid common history')
  return {history,sourceConfigHash:manifest.configHash,sourceSnapshots:audit.cells.map(({mode,seed,feedback,snapshotId})=>({mode,seed,feedback,snapshotId})),sourceConfig:manifest.config}
}
