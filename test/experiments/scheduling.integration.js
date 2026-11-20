import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSchedulingReplay } from '../../examples/scheduling-replay.js'

test('paired scheduling replay executes real Harness with verified dependency artifacts', { timeout: 30000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'schedule-replay-'))
  try {
    const result = await runSchedulingReplay({ directory, seeds: [7, 11], delayUnitMs: 20 })
    assert.equal(result.kind, 'synthetic-delay-replay')
    assert.equal(result.runs.length, 4)
    assert.deepEqual(result.runs.map(r => r.mode), ['fixed', 'metaaco', 'metaaco', 'fixed'])
    for (const run of result.runs) {
      assert.equal(run.execution.status, 'completed')
      assert.equal(run.execution.quality, 'inconclusive')
      assert.equal(run.execution.tasks.length, 4)
      // Adapter starts cross a subprocess boundary. A short timer may finish before
      // the other ready task enters the adapter; enforce capacity, not a minimum overlap.
      assert.ok(run.maxActive >= 1 && run.maxActive <= 2)
      assert.equal(run.artifactsVerified, 4)
      assert.ok(run.measured.executionWallTimeMs > 0)
      assert.ok(run.measured.totalWallTimeMs >= run.measured.executionWallTimeMs)
      const starts = run.timeline.filter(e => e.type === 'start').map(e => e.taskId)
      if (run.mode === 'fixed') assert.deepEqual(starts.slice(0, 2).sort(), ['docs', 'review'])
      else assert.ok(starts.slice(0, 2).includes('patch'))
      const patch = run.timeline.find(e => e.type === 'finish' && e.taskId === 'patch')
      const tests = run.timeline.find(e => e.type === 'start' && e.taskId === 'tests')
      assert.ok(tests.atMs >= patch.atMs)
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
