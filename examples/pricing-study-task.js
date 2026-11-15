import { execFileSync } from 'node:child_process'

const revision = '9d485e7afd2a144aff4c9893be8a907545ee5f28'
const editable = 'src/metrics/pricing.js'
const description = 'Add exported calculateCostRange(usage, price, upperBounds) to src/metrics/pricing.js. Return {currency,minMicrounits,maxMicrounits}. For billed fields with known usage, use the observed count for both endpoints. For unknown fields, use zero for the minimum and the supplied upperBounds count for the maximum. If a charged unknown field has no upper bound, return a null maximum. Ignore unknown usage for zero-rate fields. Round each total upward once, using existing rate units and safe integer protections. Preserve calculateCost and normalizeUsage behavior.'
const setup = `
const {test} = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('./src/metrics/pricing.js');
const price = {schemaVersion:1,id:'fixture',provider:'offline',model:'fixture',
  modelRevision:'1',currency:'USD',effectiveAt:'2026-01-01T00:00:00Z',source:'fixture',
  rates:{inputTokens:300000,outputTokens:1200000,cacheReadTokens:0,cacheWriteTokens:0}};
`
const targets = {
  'bounded usage': "assert.deepEqual(api.calculateCostRange({inputTokens: 3}, price, {outputTokens: 2}), {currency:'USD',minMicrounits:1,maxMicrounits:4})",
  'unknown maximum': "assert.deepEqual(api.calculateCostRange({inputTokens: 3}, price, {}), {currency:'USD',minMicrounits:1,maxMicrounits:null})",
  'known usage': "assert.deepEqual(api.calculateCostRange({inputTokens: 3, outputTokens: 1}, price, {outputTokens: 9}), {currency:'USD',minMicrounits:3,maxMicrounits:3})",
}

export function pricingStudyTask(repoDirectory) {
  const paths = ['package.json', 'index.js', 'src/contracts/bank.js', editable]
  const files = Object.fromEntries(paths.map(path => [path,
    execFileSync('git', ['show', `${revision}:${path}`], { cwd: repoDirectory, encoding: 'utf8' })]))
  const baseSnapshot = { revision, files }
  const testSpec = { schemaVersion: 1, id: 'pricing-range', acceptanceCriteria: [description],
    timeoutMs: 15000, maxOutputBytes: 100000, suites: [
      { id: 'target', kind: 'target', expectedRedTests: Object.keys(targets), files: {
        'range.test.cjs': setup + Object.entries(targets).map(([name, check]) => `
          test(${JSON.stringify(name)}, async () => {
            const api = await load();
            assert.equal(typeof api.calculateCostRange, 'function');
            ${check};
          });`).join('\n'),
      } },
      { id: 'regression', kind: 'regression', expectedRedTests: [], files: {
        'pricing.test.cjs': setup + `test('aggregate cost and missing usage', async () => {
          const api = await load();
          assert.deepEqual(api.calculateCost({inputTokens:3,outputTokens:1},price), {currency:'USD',microunits:3,reason:null});
          assert.equal(api.calculateCost({inputTokens:3},price).microunits,null);
        });`,
      } },
    ] }
  return { baseSnapshot, editablePaths: [editable], request: { schemaVersion: 1, taskId: 'pricing-range', repo: 'dsh-metaaco', baseCommit: revision,
    description: `${description}\nOnly edit ${editable}. Describe changes only to this file.\nSource:\n${files[editable]}`,
    provenance: { source: 'pinned-repository-case' }, testSpec } }
}
