import { createTextRuntime } from './offline-runtime.js'
import { createDeepSeekAdapter } from '../src/adapters/harness/deepseek.js'

export function createDeepSeekRuntime({ guardAdapter, signal, key, fetchImpl, promptFor, outputFor }) {
  return createTextRuntime({ guardAdapter, signal, provider: 'deepseek', outputFor,
    createAdapter: () => createDeepSeekAdapter({ key, fetchImpl }),
    promptFor: promptFor ?? (envelope => [
      'Complete this coding task. Return only a JSON object with exactly two keys: revision and files.',
      'revision is required and must be a nonempty string, for example green-v1.',
      'Example shape: {"revision":"green-v1","files":{"source.js":"full source text"}}.',
      'The files field maps relative file paths to full text contents. Do not include test files.',
      JSON.stringify(envelope),
    ].join('\n')),
  })
}
