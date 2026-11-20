import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import { EXPERIMENT_MODES } from '../src/experiments/index.js'
import { templateStudyTasks } from './template-study-tasks.js'

export function coldStartProtocol() {
  const task = templateStudyTasks().find(row => row.request.taskId === 'stock-reservation')
  return {
    schemaVersion: 1,
    protocolId: 'stock-cold-start-pilot-v1',
    status: 'design-only',
    seeds: [7, 11, 19, 23, 31],
    modes: [...EXPERIMENT_MODES],
    splits: { train: [task.request.taskId], validation: [], test: [] },
    task,
    initialHistory: 'empty',
    historyIsolation: 'per-mode-and-seed',
    historyAccess: 'completed-earlier-attempts-only',
    externalExperienceAllowed: false,
    attemptsPerCell: 20,
    attemptDeadlineMs: 120000,
    routeAgentSlots: 2,
    concurrentAttempts: 1,
    searchEvaluations: 100,
    routeCatalogSize: 1836,
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    dockerImage: 'sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5',
    stopOnFirstSuccess: false,
    automaticRetries: false,
    paidDispatchImplemented: false,
  }
}

export function validateColdStartProtocol(config) {
  assert.deepEqual(config, coldStartProtocol(), 'Protocol differs from the pinned v1 design')
  assert.equal(new Set(config.seeds).size, config.seeds.length)
  const allTasks = Object.values(config.splits).flat()
  assert.equal(new Set(allTasks).size, allTasks.length, 'Splits overlap')
  return {
    protocolId: config.protocolId,
    sha256: createHash('sha256').update(JSON.stringify(config)).digest('hex'),
    isolatedBanks: config.seeds.length * config.modes.length,
    maximumAttempts: config.seeds.length * config.modes.length * config.attemptsPerCell,
    apiCalls: 0,
    readyForPaidExecution: false,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify({ ...validateColdStartProtocol(coldStartProtocol()), protocol: coldStartProtocol() }, null, 2))
}
