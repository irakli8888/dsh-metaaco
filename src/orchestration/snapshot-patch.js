import { validateSnapshot } from '../evaluation/runner.js'

export function applySnapshotPatch(base, patch, editablePaths) {
  validateSnapshot(base)
  validateSnapshot(patch)
  for (const path of Object.keys(patch.files)) {
    if (!editablePaths.includes(path) || !Object.hasOwn(base.files, path)) {
      throw new Error(`Snapshot path is not editable: ${path}`)
    }
  }
  return { revision: patch.revision, files: { ...base.files, ...patch.files } }
}

export function applyTextEdits(base, patch, editablePaths) {
  if (!Array.isArray(patch.edits) || patch.edits.length > 32) throw new Error('Expected at most 32 text edits')
  const files = { ...base.files }
  for (const { path, before, after } of patch.edits) {
    if (!editablePaths.includes(path) || !Object.hasOwn(files, path)) {
      throw new Error(`Snapshot path is not editable: ${path}`)
    }
    if (typeof before !== 'string' || !before.length || typeof after !== 'string') {
      throw new Error('Expected nonempty match and string replacement')
    }
    const source = files[path]
    const start = source.indexOf(before)
    if (start < 0 || source.indexOf(before, start + 1) >= 0) throw new Error('Text edit needs a unique match')
    files[path] = source.slice(0, start) + after + source.slice(start + before.length)
  }
  const snapshot = { revision: patch.revision, files }
  validateSnapshot(snapshot)
  return snapshot
}
