/**
 * The JSON-store scaffold shared by prefs.js (`last-session.json`) and
 * settings.js (`settings.json`). The two stores deliberately stay SEPARATE
 * modules with separate files (each file's meaning stays single — both
 * headers say so; only the shape is shared, per the code-review finding):
 *
 *  - a file store under `host.dataDir` (`~/.dsh-tui/backends/codebuddy/`),
 *    never a guessed path beyond it — the file is created on the FIRST WRITE
 *    only, never on a read;
 *  - a corrupt or unreadable file reads as "no choice" ({}) — a broken memory
 *    must not break sessions;
 *  - a write that fails degrades to no memory, never a broken session, with
 *    the reason on the host's opt-in debug sink;
 *  - no `dataDir` → an in-memory store per host OBJECT (WeakMap): the
 *    launcher's `sessionPrefs(host)` and the sessions opened on the same
 *    host share one store for the host's lifetime (degradation contract,
 *    host-surface notes §11).
 *
 * The factory is curried: build it once per module (fixed fileName/label and
 * verb sets), call the result per host.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * @param {object} spec
 *   fileName: the store file under host.dataDir (e.g. 'last-session.json')
 *   label: the debug-line prefix ('last-session' / 'settings')
 *   memoryStore(): build the memory-backed verb set (no dataDir degradation)
 *   fileStore({read, write}): build the file-backed verb set over the
 *     scaffold's read/write primitives (read returns the parsed object or {},
 *     write replaces the whole object atomically-in-spirit)
 * @returns {(host: object) => object} the per-host store
 */
export function createJsonStore({ fileName, label, memoryStore, fileStore }) {
  const memoryByHost = new WeakMap()
  return host => {
    const dataDir = typeof host?.dataDir === 'string' && host.dataDir !== '' ? host.dataDir : null
    if (dataDir === null) {
      let store = memoryByHost.get(host)
      if (store === undefined) {
        store = memoryStore()
        memoryByHost.set(host, store)
      }
      return store
    }
    const file = join(dataDir, fileName)
    const debug = typeof host?.debug === 'function' ? message => host.debug(message) : () => {}

    function readStore() {
      try {
        if (!existsSync(file)) return {}
        const raw = JSON.parse(readFileSync(file, 'utf8'))
        return raw !== null && typeof raw === 'object' ? raw : {}
      } catch (error) {
        debug(`${label} store unreadable, treating as empty: ${error?.message}`)
        return {}
      }
    }

    function writeStore(store) {
      try {
        mkdirSync(dataDir, { recursive: true })
        writeFileSync(file, `${JSON.stringify(store)}\n`, 'utf8')
      } catch (error) {
        // A store that cannot be written degrades to no memory, never a
        // broken session.
        debug(`${label} store write failed: ${error?.message}`)
      }
    }

    return fileStore({ read: readStore, write: writeStore })
  }
}
