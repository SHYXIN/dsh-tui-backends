/**
 * The backend's model-choice memory (ticket T6) — the `/model` selection
 * persisted to the backend's own prefs, following the T5 last-session pattern
 * (prefs.js) exactly: a `settings.json` store under `host.dataDir`
 * (`~/.dsh-tui/backends/codebuddy/`, never a guessed path beyond it), an
 * in-memory store per host object when there is no dataDir (degradation
 * contract, notes §11), the store file created only on the first write, and
 * a corrupt file degrading to "no choice" — a broken memory must not break
 * sessions.
 *
 * Deliberately a separate store from `last-session.json`: the T5 store's
 * contract (and its file) stays untouched; each file's meaning stays single.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const STORE_FILE = 'settings.json'

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

const memoryByHost = new WeakMap()

function createFileSettings(dataDir, debug = () => {}) {
  const file = join(dataDir, STORE_FILE)

  function readStore() {
    try {
      if (!existsSync(file)) return {}
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      return raw !== null && typeof raw === 'object' ? raw : {}
    } catch (error) {
      debug(`settings store unreadable, treating as empty: ${error?.message}`)
      return {}
    }
  }

  function writeStore(store) {
    try {
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(file, `${JSON.stringify(store)}\n`, 'utf8')
    } catch (error) {
      // A store that cannot be written degrades to no memory, never a broken
      // session.
      debug(`settings store write failed: ${error?.message}`)
    }
  }

  return {
    model() {
      const id = readStore().model
      return typeof id === 'string' && id !== '' ? id : undefined
    },
    setModel(id) {
      if (typeof id !== 'string' || id === '') return
      writeStore({ ...readStore(), model: id })
    },
  }
}

/** Build the settings store for one host. File-backed when `host.dataDir`
 *  exists, memory-backed (per host object) when it does not. */
export function createCodebuddySettings(host) {
  const dataDir = typeof host?.dataDir === 'string' && host.dataDir !== '' ? host.dataDir : null
  if (dataDir === null) {
    let store = memoryByHost.get(host)
    if (store === undefined) {
      store = memorySettings()
      memoryByHost.set(host, store)
    }
    return store
  }
  return createFileSettings(dataDir, typeof host?.debug === 'function' ? message => host.debug(message) : () => {})
}
