// Black-box tests for the backend's model-choice memory (ticket T6) — the
// `/model` selection persisted to the backend's own prefs, following the T5
// last-session pattern exactly: a `settings.json` store under `host.dataDir`,
// an in-memory store per host object when there is no dataDir (never a
// guessed path), corrupt file degrades to "no choice", directory created on
// the first write only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCodebuddySettings } from '../settings.js'

test('without host.dataDir the store is memory, per host object, no file written', () => {
  const hostA = {}
  const settingsA = createCodebuddySettings(hostA)
  assert.equal(settingsA.model(), undefined)
  settingsA.setModel('stub-pro')
  assert.equal(settingsA.model(), 'stub-pro')
  // Same host object → the same store (the launcher and sessions share it).
  assert.equal(createCodebuddySettings(hostA).model(), 'stub-pro')
  // A different host → a separate store.
  assert.equal(createCodebuddySettings({}).model(), undefined)
})

test('with host.dataDir the choice persists to <dataDir>/settings.json and survives a "restart"', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codebuddy-settings-'))
  try {
    createCodebuddySettings({ dataDir }).setModel('stub-max')
    const file = join(dataDir, 'settings.json')
    assert.ok(existsSync(file), 'the store file exists under dataDir')
    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(onDisk.model, 'stub-max')
    // A fresh factory (new host object, same dataDir — the "restart" case)
    // reads the same choice back: this is what makes /model apply to the
    // NEXT session open.
    assert.equal(createCodebuddySettings({ dataDir }).model(), 'stub-max')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('junk ids are ignored (never persisted); the choice is independent of last-session.json', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codebuddy-settings-'))
  try {
    const settings = createCodebuddySettings({ dataDir })
    settings.setModel('')
    settings.setModel(42)
    settings.setModel(undefined)
    assert.equal(settings.model(), undefined)
    settings.setModel('ok')
    // The two stores are separate files: the model choice never lands in the
    // T5 last-session store (and vice versa).
    const sessionFile = join(dataDir, 'last-session.json')
    assert.ok(!existsSync(sessionFile), 'settings writes must not touch last-session.json')
    assert.equal(JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')).model, 'ok')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('a corrupt settings file degrades to no choice, and a later write recovers the store', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codebuddy-settings-'))
  try {
    writeFileSync(join(dataDir, 'settings.json'), '{ not json', 'utf8')
    const settings = createCodebuddySettings({ dataDir })
    assert.equal(settings.model(), undefined, 'corrupt file reads as no choice')
    settings.setModel('recovered')
    assert.equal(createCodebuddySettings({ dataDir }).model(), 'recovered')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('store creation does not mkdir on read, only on first write', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codebuddy-settings-'))
  const nested = join(dataDir, 'backends', 'codebuddy')
  try {
    const settings = createCodebuddySettings({ dataDir: nested })
    assert.equal(settings.model(), undefined)
    assert.ok(!existsSync(nested), 'reading a missing store must not create the directory')
    settings.setModel('first-write')
    assert.ok(existsSync(nested), 'the first write creates the directory')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})
