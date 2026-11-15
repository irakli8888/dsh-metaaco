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
