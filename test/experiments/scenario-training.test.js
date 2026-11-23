import {test} from 'node:test'
import assert from 'node:assert/strict'
import {buildTrainingEvidence} from '../../src/experiments/scenario-training.js'
test('training uses sealed same-task outcomes only and seeds from successful observations',()=>{
 const d=new Map([['a',{route:[['implement','deepseek','cheap',[]]],choices:{implement:'implement/0'},costMicrounits:1}],['b',{route:[['implement','deepseek','strong',[]]],choices:{implement:'implement/1'},costMicrounits:2}]])
 const good={taskId:'train-s7',state:'succeeded',evaluationVerified:true,evaluation:{status:'success'},outcome:{measured:{coverageComplete:true}}}
 const r=buildTrainingEvidence([{...good,attemptId:'a'},{...good,taskId:'other-s7',attemptId:'b'},{...good,attemptId:'b',state:'failed'}],d,'train-s7')
 assert.equal(r.observedAttemptIds.length,2)
 assert.equal(r.qualityEvidence.length,2)
 assert.equal(r.qualityEvidence.reduce((n,x)=>n+x.successes,0),1)
 assert.deepEqual(r.warmStartChoices,[{implement:'implement/0'}])
 assert.equal(buildTrainingEvidence([{...good,attemptId:'a',outcome:{measured:{coverageComplete:false}}}],d,'train-s7').qualityEvidence.length,0)
})
