import { fields, text, canonicalJson, artifactRef } from '../contracts/bank.js'
import { hash, clone, compare, utc, validatePolicy } from '../selector/contracts.js'
import { createSelectorSnapshot, validateSelectorSnapshot, selectStrategy } from '../selector/index.js'

function manifestValue(input) {
  fields(input, ['schemaVersion', 'experimentId', 'mode', 'splits'], 'Feedback manifest')
  if (input.schemaVersion !== 1 || !['online-train', 'frozen'].includes(input.mode)) throw new Error('Unsupported feedback manifest')
  text(input.experimentId, 'experimentId')
  fields(input.splits, ['train', 'validation', 'test'], 'Dataset splits')
  const seen = new Set(), manifest = clone(input)
  for (const key of ['train', 'validation', 'test']) {
    const ids = manifest.splits[key]
    if (!Array.isArray(ids)) throw new Error('Dataset split requires task IDs')
    for (const id of ids) {
      text(id, 'split taskId')
      if (seen.has(id)) throw new Error('Dataset splits must be disjoint and unique')
      seen.add(id)
    }
    ids.sort(compare)
  }
  return manifest
}
const same = (a, b) => canonicalJson(a) === canonicalJson(b)
function summary(records, newAttemptIds) {
  const states = { succeeded: 0, failed: 0, timeout: 0, cancelled: 0, interrupted: 0, inconclusive: 0 }
  for (const record of records) states[record.state]++
  return { total: records.length, states, boundSelections: records.filter(r => r.armId !== null).length,
    verifiedSuccesses: records.filter(r => r.state === 'succeeded' && r.evaluationVerified).length, newAttemptIds }
}

/** Reads immutable artifact data only; does not consult new attempt outcomes. */
export function readFeedback(bank, ref) {
  artifactRef(ref)
  const revision = JSON.parse(bank.getArtifact(ref))
  fields(revision, ['schemaVersion', 'revisionId', 'parent', 'manifest', 'policy', 'cutoff', 'snapshot', 'summary'], 'Feedback revision')
  const { revisionId, ...payload } = revision
  if (revision.schemaVersion !== 1 || revisionId !== hash(payload)) throw new Error('Invalid feedback revision hash/version')
  if (revision.parent !== null) artifactRef(revision.parent)
  const manifest = manifestValue(revision.manifest)
  validatePolicy(revision.policy); utc(revision.cutoff)
  artifactRef(revision.snapshot)
  const snapshot = JSON.parse(bank.getArtifact(revision.snapshot))
  validateSelectorSnapshot(snapshot, revision.cutoff)
  if (snapshot.cutoff !== revision.cutoff || !same(snapshot.trainingTaskIds, manifest.splits.train)) throw new Error('Feedback snapshot does not match manifest/cutoff')
  const added = revision.summary?.newAttemptIds
  if (!Array.isArray(added) || new Set(added).size !== added.length
    || added.some(id => !snapshot.records.some(r => r.attemptId === id))
    || !same(revision.summary, summary(snapshot.records, added))) throw new Error('Invalid feedback summary')
  return { revision, snapshot }
}

/** Explicit append-only advancement. Caller persists the returned artifact ref as the active revision. */
export function advanceFeedback(bank, { manifest: input, policy, cutoff, previous = null }) {
  const manifest = manifestValue(input)
  validatePolicy(policy); utc(cutoff)
  const prior = previous === null ? null : readFeedback(bank, previous)
  if (prior) {
    if (!same(prior.revision.manifest, manifest) || !same(prior.revision.policy, policy)) throw new Error('Feedback lineage cannot change manifest or policy')
    if (Date.parse(cutoff) < Date.parse(prior.revision.cutoff)) throw new Error('Feedback cutoff cannot go backwards')
    if (manifest.mode === 'frozen' && cutoff !== prior.revision.cutoff) throw new Error('Cannot advance a frozen revision')
  }
  const snapshot = createSelectorSnapshot(bank, { trainingTaskIds: manifest.splits.train, cutoff })
  if (prior?.snapshot.snapshotId === snapshot.snapshotId) return clone(previous)
  if (prior && manifest.mode === 'frozen') throw new Error('Cannot update a frozen revision')
  const old = new Map((prior?.snapshot.records ?? []).map(r => [r.attemptId, r]))
  const current = new Map(snapshot.records.map(r => [r.attemptId, r]))
  for (const [id, record] of old) {
    if (!current.has(id) || !same(record, current.get(id))) throw new Error('Previously observed feedback history changed')
  }
  const added = snapshot.records.filter(r => !old.has(r.attemptId))
  if (prior && added.some(r => Date.parse(r.finishedAt) < Date.parse(prior.revision.cutoff))) {
    throw new Error('Late history predates the sealed cutoff; create a separate lineage')
  }
  const snapshotRef = bank.putArtifact(Buffer.from(canonicalJson(snapshot)))
  const payload = { schemaVersion: 1, parent: previous === null ? null : clone(previous), manifest,
    policy: clone(policy), cutoff, snapshot: snapshotRef,
    summary: summary(snapshot.records, added.map(r => r.attemptId)) }
  return bank.putArtifact(Buffer.from(canonicalJson({ ...payload, revisionId: hash(payload) })))
}

/** Frozen selection against a pinned feedback revision; no live-bank learning side effect. */
export function selectWithFeedback(bank, ref, { request, candidates, selectedAt = new Date().toISOString() }) {
  const { revision, snapshot } = readFeedback(bank, ref)
  return selectStrategy({ request, candidates, selectedAt, policy: revision.policy, snapshot })
}
