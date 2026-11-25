// Black-box tests for the shared JSON-store scaffold (store.js) — the shape
// prefs.js (last-session.json) and settings.js (settings.json) both build on:
// a file store under host.dataDir created on the FIRST WRITE only, a corrupt
// or unreadable file reading as "no choice", a failed write degrading to no
// memory, and a per-host-object in-memory store when there is no dataDir
// (never a guessed path — host-surface notes §11). The two consumers keep
// their own modules, files, and verb sets; only the degradation scaffold is
// shared, and these tests pin it once at the factory seam.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJsonStore } from '../store.js'

/** A two-verb store over the scaffold: the minimal shape both consumers build. */
function makeFactory() {
  return createJsonStore({
    fileName: 'probe.json',
    label: 'probe',
    memoryStore: () => {
      let value
      return { get: () => value, set: v => { value = v } }
    },
    fileStore: ({ read, write }) => ({
      get: () => read().value,
      set: v => write({ ...read(), value: v }),
    }),
  })
}

test('no dataDir → per-host-object memory store, nothing on disk', () => {
  const factory = makeFactory()
  const hostA = {}
  factory(hostA).set('one')
  assert.equal(factory(hostA).get(), 'one', 'same host object shares the store')
  assert.equal(factory({}).get(), undefined, 'another host gets its own store')
})

test('with dataDir the store persists to <dataDir>/probe.json and reads back across factories', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codebuddy-store-'))
  try {
    makeFactory()({ dataDir }).set('persisted')
    const file = join(dataDir, 'probe.json')
    assert.ok(existsSync(file), 'the store file exists under dataDir')
    assert.equal(makeFactory()({ dataDir }).get(), 'persisted', 'a fresh factory reads it back')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('a corrupt file reads as empty and a later write recovers; reads never mkdir', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codebuddy-store-'))
  const nested = join(dataDir, 'backends', 'codebuddy')
  try {
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'probe.json'), '{ not json', 'utf8')
    const store = makeFactory()({ dataDir: nested })
    assert.equal(store.get(), undefined, 'corrupt file reads as no choice')
    store.set('recovered')
    assert.equal(store.get(), 'recovered', 'a write after corruption recovers')
    assert.ok(existsSync(nested), 'the first write created the directory')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('reading a missing store does not create the directory; a failed write degrades via host.debug', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codebuddy-store-'))
  const nested = join(dataDir, 'backends', 'codebuddy')
  const debugLines = []
  try {
    const store = makeFactory()({ dataDir: nested, debug: message => debugLines.push(String(message)) })
    assert.equal(store.get(), undefined)
    assert.ok(!existsSync(nested), 'a read must not mkdir')
    // A failed write: dataDir points at an existing FILE, so mkdirSync fails —
    // the degradation note must reach the host's debug sink, never a throw.
    const blocker = join(dataDir, 'blocker')
    writeFileSync(blocker, 'x', 'utf8')
    assert.doesNotThrow(() => makeFactory()({ dataDir: blocker, debug: message => debugLines.push(String(message)) }).set('nope'))
    assert.ok(debugLines.some(line => line.includes('probe store write failed')), `degradation note reaches debug: ${debugLines.join(' | ')}`)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})
