import { createTextRuntime } from './offline-runtime.js'
import { createDeepSeekAdapter } from '../src/adapters/harness/deepseek.js'

export function createDeepSeekRuntime({ guardAdapter, signal, key, fetchImpl }) {
  return createTextRuntime({ guardAdapter, signal, provider: 'deepseek',
    createAdapter: () => createDeepSeekAdapter({ key, fetchImpl }),
    promptFor: envelope => [
      'Complete this coding task. Return only a JSON object with revision and files.',
      'The files field maps relative file paths to full text contents. Do not include test files.',
      JSON.stringify(envelope),
    ].join('\n'),
  })
}
