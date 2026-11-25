/**
 * The backend's lastSession memory — the `BackendSessionPrefs` seam
 * (`launch.sessionPrefs(host)`, host-surface notes §2). Bare `--resume` asks
 * THIS store for the most recent session id of THIS backend, so it is scoped
 * to the backend by construction: the host hands us `host.dataDir`
 * (`~/.dsh-tui/backends/codebuddy/`) and we never guess a path beyond it.
 *
 * Degradation contract (notes §11): no `dataDir` → an in-memory store per
 * host object, nothing persisted. The store file is only created on the first
 * write, never on a read, and a corrupt file degrades to "no session" — a
 * broken memory must not break sessions.
 *
 * Memory stores are keyed by host object (WeakMap): the launcher calls
 * `sessionPrefs(host)` before any session opens and sessions record through
 * the same host, so both share one store for the host's lifetime.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const STORE_FILE = 'last-session.json'

function dataDirOf(host) {
  return typeof host?.dataDir === 'string' && host.dataDir !== '' ? host.dataDir : null
}

function memoryPrefs() {
  let last = undefined
  return {
    lastSession: () => last,
    setLastSession: id => {
      if (typeof id !== 'string' || id === '') return
      last = id
    },
    touch: id => {
      if (typeof id !== 'string' || id === '') return
      last = id
    },
    forget: id => {
      if (last === id) last = undefined
    },
  }
}

const memoryByHost = new WeakMap()

function createFilePrefs(dataDir, debug = () => {}) {
  const file = join(dataDir, STORE_FILE)

  function readStore() {
    try {
      if (!existsSync(file)) return {}
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      return raw !== null && typeof raw === 'object' ? raw : {}
    } catch (error) {
      debug(`last-session store unreadable, treating as empty: ${error?.message}`)
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
      debug(`last-session store write failed: ${error?.message}`)
    }
  }

  return {
    lastSession() {
      const id = readStore().lastSessionId
      return typeof id === 'string' && id !== '' ? id : undefined
    },
    setLastSession(id) {
      if (typeof id !== 'string' || id === '') return
      writeStore({ ...readStore(), lastSessionId: id })
    },
    touch(id) {
      if (typeof id !== 'string' || id === '') return
      writeStore({ ...readStore(), lastSessionId: id })
    },
    forget(id) {
      if (typeof id !== 'string' || id === '') return
      const store = readStore()
      if (store.lastSessionId !== id) return
      writeStore({ ...store, lastSessionId: undefined })
    },
  }
}

/** Build the prefs for one host. File-backed when `host.dataDir` exists,
 *  memory-backed (per host object) when it does not. */
export function createCodebuddyPrefs(host) {
  const dataDir = dataDirOf(host)
  if (dataDir === null) {
    let store = memoryByHost.get(host)
    if (store === undefined) {
      store = memoryPrefs()
      memoryByHost.set(host, store)
    }
    return store
  }
  return createFilePrefs(dataDir, typeof host?.debug === 'function' ? message => host.debug(message) : () => {})
}
