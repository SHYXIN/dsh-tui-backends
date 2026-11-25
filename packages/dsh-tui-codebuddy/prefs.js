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
 * broken memory must not break sessions. That scaffold is shared with
 * settings.js through store.js; the FILE and the verbs stay this module's own
 * (one file, one meaning).
 *
 * Memory stores are keyed by host object (WeakMap inside store.js): the
 * launcher calls `sessionPrefs(host)` before any session opens and sessions
 * record through the same host, so both share one store for the host's
 * lifetime.
 *
 * The four-verb shape is the host contract, verbatim (host-surface notes §2):
 * `BackendSessionPrefs{lastSession(), setLastSession(id), touch(id),
 * forget(id)}` — `touch` and `setLastSession` coexist because the host's
 * interface declares both, not because they differ here (both re-point the
 * store at the given id).
 */
import { createJsonStore } from './store.js'

function memoryPrefs() {
  let last = undefined
  return {
    lastSession: () => last,
    setLastSession: id => {
      if (typeof id !== 'string' || id === '') return
      last = id
    },
    // Host contract requires this verb to exist (notes §2, verbatim:
    // `BackendSessionPrefs{lastSession(), setLastSession(id), touch(id),
    // forget(id)}`) — it re-points the store exactly like setLastSession.
    touch: id => {
      if (typeof id !== 'string' || id === '') return
      last = id
    },
    forget: id => {
      if (last === id) last = undefined
    },
  }
}

const createCodebuddyPrefsFor = createJsonStore({
  fileName: 'last-session.json',
  label: 'last-session',
  memoryStore: memoryPrefs,
  fileStore: ({ read, write }) => ({
    lastSession() {
      const id = read().lastSessionId
      return typeof id === 'string' && id !== '' ? id : undefined
    },
    setLastSession(id) {
      if (typeof id !== 'string' || id === '') return
      write({ ...read(), lastSessionId: id })
    },
    // Host contract requires this verb to exist (see the module header quote
    // of notes §2) — same semantics as setLastSession here.
    touch(id) {
      if (typeof id !== 'string' || id === '') return
      write({ ...read(), lastSessionId: id })
    },
    forget(id) {
      if (typeof id !== 'string' || id === '') return
      const store = read()
      if (store.lastSessionId !== id) return
      write({ ...store, lastSessionId: undefined })
    },
  }),
})

/** Build the prefs for one host. File-backed when `host.dataDir` exists,
 *  memory-backed (per host object) when it does not. */
export function createCodebuddyPrefs(host) {
  return createCodebuddyPrefsFor(host)
}
