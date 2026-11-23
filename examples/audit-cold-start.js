import {readFile,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {StrategyBank} from '../src/bank/index.js'
import {readFeedback} from '../src/feedback/index.js'
const directory=process.argv[2]
if(!directory) throw Error('Supply an existing completed study directory')
const raw=await readFile(directory+'/summary.json')
const summary=JSON.parse(raw)
const manifest=JSON.parse(await readFile(directory+'/manifest.json','utf8'))
const cells=[],failures=[]
for(const trajectory of summary.trajectories){
 const {mode,seed}=trajectory
 const rows=summary.rows.filter(r=>r.mode===mode&&r.seed===seed).sort((a,b)=>a.round-b.round)
 const bank=new StrategyBank({dataDir:`${directory}/${mode}/${seed}`})
 try{
 const final=rows.at(-1).feedback
 const {snapshot}=readFeedback(bank,final)
 if(snapshot.records.length!==20)throw Error('Incomplete final history')
 cells.push({mode,seed,feedback:final,snapshotId:snapshot.snapshotId,records:snapshot.records.length,routeIds:[...new Set(rows.map(r=>r.routeId))],
   successCount:rows.filter(r=>r.verifiedSuccess).length})
 for(const row of rows.filter(r=>!r.verifiedSuccess)){
   const a=bank.getAttempt(row.attemptId)
   const end=bank.getEvents(row.attemptId).find(e=>e.kind==='dag-finish-v1')
   const failed=(end?.payload.tasks??[]).filter(t=>t.state==='failed')
   const phases=bank.getEvents(row.attemptId).filter(e=>e.kind==='evaluation-phase').map(e=>e.payload).map(p=>({phase:p.phase,reports:p.reports.map(r=>({suiteId:r.suiteId??r.kind,status:r.status,exitCode:r.exitCode,runnerError:Boolean(r.runnerError),integrityError:Boolean(r.integrityError),failedTests:(r.tests??[]).filter(t=>t.type==='test:fail').map(t=>({name:t.name,code:t.code}))}))}))
   failures.push({mode,seed,round:row.round,routeId:row.routeId,state:a.state,
     failedNodes:failed.map(t=>({id:t.id,category:/GREEN/.test(t.reason??'')?'green-gate':/Component file conflict/.test(t.reason??'')?'component-file-conflict':/REFAC/.test(t.reason??'')?'refactor-gate':/Snapshot requires only/.test(t.reason??'')?'snapshot-schema':/JSON/.test(t.reason??'')?'json-syntax':'other'})),phases})
 }
 }finally{bank.close()}
}
const audit={schemaVersion:1,sourceConfigHash:manifest.configHash,sourceSummarySha256:createHash('sha256').update(raw).digest('hex'),cells,failures}
await writeFile(directory+'/audit.json',JSON.stringify(audit,null,2))
console.log(JSON.stringify({cells:cells.length,failures:failures.length,categories:failures.flatMap(r=>r.failedNodes.map(n=>n.category)).reduce((a,k)=>(a[k]=(a[k]??0)+1,a),{})}))
