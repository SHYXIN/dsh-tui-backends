/**
 * The backend's model-choice memory (ticket T6) — the `/model` selection
 * persisted to the backend's own prefs, following the T5 last-session pattern
 * (prefs.js): a `settings.json` store under `host.dataDir`
 * (`~/.dsh-tui/backends/codebuddy/`, never a guessed path beyond it), an
 * in-memory store per host object when there is no dataDir (degradation
 * contract, notes §11), the store file created only on the first write, and
 * a corrupt file degrading to "no choice" — a broken memory must not break
 * sessions. That scaffold is shared with prefs.js through store.js; the FILE
 * and the verbs stay this module's own.
 *
 * Deliberately a separate store from `last-session.json`: the T5 store's
 * contract (and its file) stays untouched; each file's meaning stays single.
 */
import { createJsonStore } from './store.js'

function memorySettings() {
  let model
  return {
    model: () => model,
    setModel: id => {
      if (typeof id !== 'string' || id === '') return
      model = id
    },
  }
}

const createCodebuddySettingsFor = createJsonStore({
  fileName: 'settings.json',
  label: 'settings',
  memoryStore: memorySettings,
  fileStore: ({ read, write }) => ({
    model() {
      const id = read().model
      return typeof id === 'string' && id !== '' ? id : undefined
    },
    setModel(id) {
      if (typeof id !== 'string' || id === '') return
      write({ ...read(), model: id })
    },
  }),
})

/** Build the settings store for one host. File-backed when `host.dataDir`
 *  exists, memory-backed (per host object) when it does not. */
export function createCodebuddySettings(host) {
  return createCodebuddySettingsFor(host)
}
