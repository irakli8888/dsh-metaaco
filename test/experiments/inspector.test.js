import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { StrategyBank } from '../../src/bank/index.js'
import { readInspection, renderInspection } from '../../src/inspector/index.js'

test('inspector reads actual artifacts without changing Bank and escapes model HTML', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inspector-'))
  const bank = new StrategyBank({ dataDir: dir })
  try {
    const strategy = bank.register({ schemaVersion: 1, strategyId: 's', version: 1, provenance: {}, workflow: {
      name: 'fixture', description: 'fixture', stages: [{ title: 'work', agents: [{ id: 'a', prompt: 'work' }] }] } })
    bank.beginAttempt({ attemptId: 'a', strategy, selection: { mode: 'fixed' }, request: { schemaVersion: 1,
      taskId: 'task', description: 'fixture', repo: 'fixture', baseCommit: 'fixture', testSpec: {}, provenance: {} } })
    const content = '</script><script>alert("model")</script>'
    const ref = bank.putArtifact(Buffer.from(content)); bank.attachArtifact('a', 'dag-output/a', ref)
    const before = readFileSync(join(dir, 'bank.sqlite'))
    const data = readInspection([dir])
    assert.equal(data.runs.length, 1)
    assert.equal(data.runs[0].artifacts[0].text, content)
    assert.deepEqual(readFileSync(join(dir, 'bank.sqlite')), before)
    assert.equal(data.runs[0].traceAvailable, false)
    const html = renderInspection(data)
    assert.ok(!html.includes(content))
    assert.ok(html.includes('application/json'))
    writeFileSync(join(dir, 'artifacts', ref.sha256), 'corrupt')
    const damaged = readInspection([dir])
    assert.equal(damaged.runs[0].artifacts[0].text, null)
    assert.match(damaged.runs[0].artifacts[0].error, /integrity/)
  } finally { bank.close(); rmSync(dir, { recursive: true, force: true }) }
})
