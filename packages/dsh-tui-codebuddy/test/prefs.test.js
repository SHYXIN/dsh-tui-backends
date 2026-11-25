// Black-box tests for the backend's lastSession memory — the
// `BackendSessionPrefs` seam the host launcher uses for bare `--resume`
// (host-surface notes §2): `sessionPrefs(host)` must return
// {lastSession, setLastSession, touch, forget}, store under `host.dataDir`
// when the host provides one, and degrade to a per-host in-memory store when
// it does not (never guessing a path). `resumeCommand` is the user-facing
// CLI resume string.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backend, launch } from '../backend.js'
import { createCodebuddyPrefs } from '../prefs.js'

test('sessionPrefs returns the four-verb BackendSessionPrefs shape', () => {
  const prefs = launch.sessionPrefs({})
  for (const verb of ['lastSession', 'setLastSession', 'touch', 'forget']) {
    assert.equal(typeof prefs[verb], 'function', `missing verb ${verb}`)
  }
})

test('launch is attached to the backend handler object (assertBackendHandler shape)', () => {
  assert.equal(typeof backend.launch?.sessionPrefs, 'function')
  assert.equal(typeof backend.launch?.resumeCommand, 'function')
})

test('resumeCommand renders the user-facing CLI resume string', () => {
  assert.equal(launch.resumeCommand('abc-123'), 'codebuddy --resume abc-123')
})

test('without host.dataDir the store is memory, per host object, no file written', () => {
  const hostA = {}
  const prefsA1 = createCodebuddyPrefs(hostA)
  assert.equal(prefsA1.lastSession(), undefined)
  prefsA1.setLastSession('s1')
  assert.equal(prefsA1.lastSession(), 's1')
  // Same host object → the same store (the launcher and the session share it).
  assert.equal(createCodebuddyPrefs(hostA).lastSession(), 's1')
  // A different host → a separate store.
  assert.equal(createCodebuddyPrefs({}).lastSession(), undefined)
})

test('touch updates, forget clears only the matching id', () => {
  const prefs = createCodebuddyPrefs({})
  prefs.touch('t1')
  assert.equal(prefs.lastSession(), 't1')
  prefs.touch('t2')
  assert.equal(prefs.lastSession(), 't2', 'touch re-points lastSession')
  prefs.forget('other')
  assert.equal(prefs.lastSession(), 't2', 'forget of a foreign id is a no-op')
  prefs.forget('t2')
  assert.equal(prefs.lastSession(), undefined, 'forget of the stored id clears it')
})

test('junk ids are ignored (never persisted)', () => {
  const prefs = createCodebuddyPrefs({})
  prefs.setLastSession('')
  prefs.setLastSession(42)
  prefs.setLastSession(undefined)
  assert.equal(prefs.lastSession(), undefined)
  prefs.touch('ok')
  prefs.forget('')
  assert.equal(prefs.lastSession(), 'ok')
})

// ── S2: the dataDir-backed store ─────────────────────────────────────────────

test('with host.dataDir the store persists to <dataDir>/last-session.json', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codebuddy-prefs-'))
  try {
    const host = { dataDir }
    createCodebuddyPrefs(host).setLastSession('persisted-1')
    const file = join(dataDir, 'last-session.json')
    assert.ok(existsSync(file), 'the store file exists under dataDir')
    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(onDisk.lastSessionId, 'persisted-1')
    // A fresh factory (new host object, same dataDir — the "restart" case)
    // reads the same value back.
    assert.equal(createCodebuddyPrefs({ dataDir }).lastSession(), 'persisted-1')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('file store: touch/forget round-trip and reading a corrupt file degrades to no session', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codebuddy-prefs-'))
  try {
    const prefs = createCodebuddyPrefs({ dataDir })
    prefs.touch('a')
    prefs.touch('b')
    assert.equal(prefs.lastSession(), 'b')
    prefs.forget('b')
    assert.equal(prefs.lastSession(), undefined)
    assert.equal(createCodebuddyPrefs({ dataDir }).lastSession(), undefined, 'cleared on disk too')

    writeFileSync(join(dataDir, 'last-session.json'), '{ not json', 'utf8')
    assert.equal(prefs.lastSession(), undefined, 'corrupt file reads as no session')
    // and a write after corruption recovers the store
    prefs.setLastSession('recovered')
    assert.equal(createCodebuddyPrefs({ dataDir }).lastSession(), 'recovered')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('file store creation does not mkdir on read, only on first write', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codebuddy-prefs-'))
  const nested = join(dataDir, 'backends', 'codebuddy')
  try {
    const prefs = createCodebuddyPrefs({ dataDir: nested })
    assert.equal(prefs.lastSession(), undefined)
    assert.ok(!existsSync(nested), 'reading a missing store must not create the directory')
    prefs.setLastSession('first-write')
    assert.ok(existsSync(nested), 'the first write creates the directory')
    assert.equal(prefs.lastSession(), 'first-write')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})
