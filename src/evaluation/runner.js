import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { canonicalJson, fields, jsonObject, text } from '../contracts/bank.js'

export const digest = value => createHash('sha256').update(canonicalJson(value)).digest('hex')
const reporterPath = fileURLToPath(new URL('./reporter.js', import.meta.url))

export function validateFiles(files) {
  jsonObject(files, 'files')
  for (const [path, content] of Object.entries(files)) {
    if (!path || path.includes('\\') || path.includes(':') || posix.isAbsolute(path)
      || path.split('/').some(p => !p || ['.', '..', '.git', 'node_modules'].includes(p))) {
      throw new Error(`Unsafe snapshot path: ${path}`)
    }
    if (typeof content !== 'string') throw new Error('Snapshot files must contain text')
  }
  if (Buffer.byteLength(canonicalJson(files)) > 10 * 1024 * 1024) throw new Error('Snapshot exceeds 10 MiB limit')
}

export function validateSnapshot(value) {
  fields(value, ['revision', 'files'], 'Snapshot')
  text(value.revision, 'snapshot revision'); validateFiles(value.files)
}

export function validateSpec(spec) {
  fields(spec, ['schemaVersion', 'id', 'acceptanceCriteria', 'suites', 'timeoutMs', 'maxOutputBytes'], 'TestSpec')
  if (spec.schemaVersion !== 1) throw new Error('Unsupported TestSpec version')
  text(spec.id, 'TestSpec id')
  if (!Array.isArray(spec.acceptanceCriteria) || !spec.acceptanceCriteria.length) throw new Error('Acceptance criteria are required')
  spec.acceptanceCriteria.forEach(v => text(v, 'acceptance criterion'))
  for (const key of ['timeoutMs', 'maxOutputBytes']) {
    if (!Number.isSafeInteger(spec[key]) || spec[key] <= 0 || spec[key] > 2147483647) throw new Error(`Invalid ${key}`)
  }
  if (spec.maxOutputBytes > 10 * 1024 * 1024) throw new Error('Output limit exceeds 10 MiB')
  if (Buffer.byteLength(canonicalJson(spec)) > 10 * 1024 * 1024) throw new Error('TestSpec exceeds 10 MiB')
  if (!Array.isArray(spec.suites) || !spec.suites.length || spec.suites.length > 64) throw new Error('Require 1 to 64 test suites')
  const ids = new Set(), paths = new Set()
  for (const suite of spec.suites) {
    fields(suite, ['id', 'kind', 'files', 'expectedRedTests'], 'Suite')
    text(suite.id, 'suite id')
    if (ids.has(suite.id) || !['target', 'acceptance', 'regression'].includes(suite.kind)) throw new Error('Invalid or duplicate suite')
    ids.add(suite.id); validateFiles(suite.files)
    if (!Object.keys(suite.files).length) throw new Error('Suite files must be nonempty')
    for (const path of Object.keys(suite.files)) {
      if (!/\.test\.(cjs|mjs|js)$/.test(path) || paths.has(path)) throw new Error('Suite paths must be unique *.test.js/cjs/mjs files')
      paths.add(path)
    }
    if (!Array.isArray(suite.expectedRedTests)) throw new Error('expectedRedTests must be an array')
    suite.expectedRedTests.forEach(v => text(v, 'expected RED name'))
    if (new Set(suite.expectedRedTests).size !== suite.expectedRedTests.length
      || (suite.kind === 'target' ? !suite.expectedRedTests.length : suite.expectedRedTests.length)) {
      throw new Error('Only target suites require unique expected RED names')
    }
  }
  if (!spec.suites.some(s => s.kind === 'target') || !spec.suites.some(s => s.kind === 'regression')) {
    throw new Error('TestSpec requires target and regression suites')
  }
}

/** Node-only local runner for trusted code; process isolation is not an OS sandbox. */
export async function runSuite(spec, suite, snapshot, { signal } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'metaaco-evaluation-'))
  try {
    for (const [path, content] of Object.entries({ ...snapshot.files, ...suite.files })) {
      await mkdir(dirname(join(cwd, path)), { recursive: true })
      await writeFile(join(cwd, path), content, { flag: 'wx' })
    }
    const command = [process.execPath, '--max-old-space-size=128', '--test',
      '--test-concurrency=1', `--test-reporter=${reporterPath}`, '--', ...Object.keys(suite.files).sort()]
    const startedAt = new Date().toISOString(), start = performance.now()
    const result = await new Promise(resolve => {
      let child, stdout = '', stderr = '', bytes = 0, stopReason = null, spawnError = null
      const stdoutDecoder = new StringDecoder('utf8'), stderrDecoder = new StringDecoder('utf8')
      let timer
      const stop = reason => {
        stopReason ??= reason
        if (child?.pid) {
          try {
            if (process.platform === 'win32') child.kill('SIGKILL')
            else process.kill(-child.pid, 'SIGKILL')
          } catch (error) { if (error.code !== 'ESRCH') spawnError = error.message }
        }
      }
      const abort = () => stop('cancelled')
      if (signal?.aborted) { resolve({ stdout, stderr, exitCode: null, signal: null, stopReason: 'cancelled', spawnError }); return }
      try {
        child = spawn(command[0], command.slice(1), { cwd, detached: process.platform !== 'win32',
          env: { PATH: dirname(process.execPath), LANG: 'C.UTF-8',
            ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) },
          stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) { resolve({ stdout, stderr, exitCode: null, signal: null, stopReason: 'error', spawnError: error.message }); return }
      const capture = (key, data) => {
        bytes += data.length
        if (bytes > spec.maxOutputBytes) { stop('output-limit'); return }
        if (key === 'stdout') stdout += stdoutDecoder.write(data)
        else stderr += stderrDecoder.write(data)
      }
      child.stdout.on('data', data => capture('stdout', data))
      child.stderr.on('data', data => capture('stderr', data))
      child.on('error', error => { spawnError = error.message })
      timer = setTimeout(() => stop('timeout'), spec.timeoutMs)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      child.on('close', (exitCode, termSignal) => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort)
        stdout += stdoutDecoder.end(); stderr += stderrDecoder.end()
        // Kill any descendants which survived the test runner before removing its workspace.
        if (process.platform !== 'win32' && child.pid) {
          try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') spawnError = error.message }
        }
        resolve({ stdout, stderr, exitCode, signal: termSignal, stopReason, spawnError })
      })
    })
    let integrityError = null
    for (const [path, content] of Object.entries({ ...snapshot.files, ...suite.files })) {
      try {
        const stat = await lstat(join(cwd, path))
        if (!stat.isFile() || stat.isSymbolicLink() || await readFile(join(cwd, path), 'utf8') !== content) {
          integrityError = `Input file changed during test execution: ${path}`
        }
      } catch { integrityError = `Input file missing after test execution: ${path}` }
    }
    let events = [], parseError = null
    try {
      events = result.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line))
      if (events.some(e => !e || typeof e.type !== 'string')) throw new Error('Invalid test reporter event')
    }
    catch (error) { parseError = error.message }
    // Node emits a synthetic passing file test for an empty script/process.exit(0).
    // It is not evidence that a registered acceptance test actually ran.
    const fileNames = new Set(Object.keys(suite.files).flatMap(path => [path, join(cwd, path)]))
    const tests = events.filter(e => ['test:pass', 'test:fail'].includes(e.type) && !e.container && !fileNames.has(e.name))
    const counts = {
      passed: tests.filter(e => e.type === 'test:pass' && !e.skip && !e.todo).length,
      failed: tests.filter(e => e.type === 'test:fail' && !e.skip && !e.todo).length,
      skipped: tests.filter(e => e.skip || e.todo).length,
    }
    const emptyFiles = events.some(e => e.type === 'test:pass' && fileNames.has(e.name))
    const runnerError = result.spawnError ?? parseError ?? (emptyFiles ? 'A test file ran without registered tests' : null)
    let status = 'error'
    if (integrityError) status = 'integrity-error'
    else if (result.stopReason) status = result.stopReason
    else if (!runnerError && tests.length && !counts.skipped) {
      if (result.exitCode === 0 && counts.failed === 0
        && (suite.kind !== 'target' || suite.expectedRedTests.every(name => tests.some(t => t.name === name && t.type === 'test:pass')))) {
        status = 'passed'
      }
      else if (result.exitCode === 1 && counts.failed > 0) {
        status = tests.filter(t => t.type === 'test:fail').every(t => t.code === 'ERR_ASSERTION') ? 'failed' : 'error'
      }
    }
    return { schemaVersion: 1, suiteId: suite.id, kind: suite.kind, command,
      testSuiteHash: digest(suite), snapshotHash: digest(snapshot), revision: snapshot.revision,
      environment: { node: process.version, platform: process.platform, arch: process.arch, runner: 'node-test-v1' },
      startedAt, durationMs: performance.now() - start, status, counts, tests,
      ...result, runnerError, integrityError }
  } finally { await rm(cwd, { recursive: true, force: true }) }
}
