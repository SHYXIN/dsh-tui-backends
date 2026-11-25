// Black-box shape tests for the bundle's export surface — the same assertions
// the host enforces at loadBackend() time (assertBackendHandler + handler.id
// === spec.id) plus the entry-side invariants the host relies on: the default
// export is the Cordis plugin row, and importing the module has no side
// effects (the Loader may import it at any point of a boot).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import bundle, { backend } from '../backend.js'

const manifest = JSON.parse(
  readFileSync(new URL('../dsh-plugin.json', import.meta.url), 'utf8'),
)
const spec = manifest.contributes['x-dsh-tui'][0].spec

test('handler id equals the manifest spec.id', () => {
  assert.equal(backend.id, spec.id)
})

test('handler exposes detect/open functions and a descriptor label', () => {
  assert.equal(typeof backend.detect, 'function')
  assert.equal(typeof backend.open, 'function')
  assert.equal(typeof backend.descriptor?.label, 'string')
  assert.ok(backend.descriptor.label.length > 0)
})

test('default export is a function (the Cordis plugin row)', () => {
  assert.equal(typeof bundle, 'function')
})

test('importing the module has no side effects; re-import yields an equivalent, distinct handler', async () => {
  const globalKeysBefore = new Set(Object.getOwnPropertyNames(globalThis))
  const signalListenersBefore =
    process.listenerCount('exit') + process.listenerCount('beforeExit') + process.listenerCount('unhandledRejection')

  // A cache-busted specifier forces a fresh module evaluation, so any
  // top-level global registration would happen again here.
  const again = await import(new URL('../backend.js?reimport=1', import.meta.url).href)

  assert.equal(typeof again.backend.detect, 'function')
  assert.equal(again.backend.id, backend.id)
  // Distinct instance: no shared mutable singleton is required to exist.
  assert.notEqual(again.backend, backend)
  assert.deepEqual(
    Object.getOwnPropertyNames(globalThis).filter(key => !globalKeysBefore.has(key)),
    [],
    'import must not register anything on globalThis',
  )
  assert.equal(
    process.listenerCount('exit') + process.listenerCount('beforeExit') + process.listenerCount('unhandledRejection'),
    signalListenersBefore,
    'import must not register process listeners',
  )
})
