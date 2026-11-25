// Capabilities alignment (ticket T6 acceptance): the manifest's declared
// capability names and the runtime Session capabilities key set must agree
// EXACTLY — the runtime returns no key the manifest omits (未声明面无残留路由)
// and the manifest declares nothing the session fails to provide. Every name
// must also be inside the host's 27-member SessionCapabilities vocabulary
// (host-surface notes §3); an unknown name would degrade the bundle's
// admission to compatible_degraded.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { backend } from '../backend.js'

const STUB_PATH = fileURLToPath(new URL('./fake-codebuddy-cli.js', import.meta.url))
process.env.CODEBUDDY_CODE_PATH = STUB_PATH

const SAVED_ENV = {
  CODEBUDDY_CODE_PATH: process.env.CODEBUDDY_CODE_PATH,
  CB_FAKE_SCRIPT: process.env.CB_FAKE_SCRIPT,
  CB_FAKE_MARKER_DIR: process.env.CB_FAKE_MARKER_DIR,
}
test.after(() => {
  for (const key of ['CODEBUDDY_CODE_PATH', 'CB_FAKE_SCRIPT', 'CB_FAKE_MARKER_DIR']) {
    if (SAVED_ENV[key] === undefined) delete process.env[key]
    else process.env[key] = SAVED_ENV[key]
  }
})

// The host's SessionCapabilities member list (host-surface notes §3), verbatim.
const CAPABILITY_VOCABULARY = Object.freeze([
  'pendingRetraction', 'permissions', 'questions', 'models', 'effort', 'modes', 'channels',
  'compact', 'init', 'rewind', 'fork', 'subagents', 'tasks', 'transcript', 'mcp', 'sideQuery',
  'rename', 'color', 'images', 'commands', 'context', 'account', 'auth', 'workingActivity',
  'diagnostics', 'goals', 'native',
])

test('manifest capabilities sit inside the host vocabulary and never touch the native escape hatch', () => {
  const declaration = JSON.parse(readFileSync(new URL('../dsh-plugin.json', import.meta.url), 'utf8'))
  const spec = declaration.contributes['x-dsh-tui'][0].spec
  assert.ok(Array.isArray(spec.capabilities) && spec.capabilities.length > 0)
  for (const name of spec.capabilities) {
    assert.ok(CAPABILITY_VOCABULARY.includes(name), `manifest capability ${name} is in the host vocabulary`)
  }
  assert.ok(!spec.capabilities.includes('native'), 'a third-party bundle never declares native')
})

test('runtime Session capabilities keys equal the manifest declaration exactly (⊆ and ≈)', async () => {
  const declaration = JSON.parse(readFileSync(new URL('../dsh-plugin.json', import.meta.url), 'utf8'))
  const declared = declaration.contributes['x-dsh-tui'][0].spec.capabilities

  const world = mkdtempSync(join(tmpdir(), 'codebuddy-caps-'))
  mkdirSync(join(world, 'project'))
  mkdirSync(join(world, 'markers'))
  delete process.env.CB_FAKE_SCRIPT
  process.env.CB_FAKE_MARKER_DIR = join(world, 'markers')
  try {
    const session = await backend.open({ kind: 'create', cwd: join(world, 'project') }, {
      cwd: process.cwd(),
      locale: () => 'zh',
      debug: () => {},
      warn: () => {},
    })
    try {
      const runtime = Object.keys(session.capabilities)
      // ⊆: the runtime returns nothing outside the declaration — an undeclared
      // capability would be a route the manifest never admitted.
      assert.ok(runtime.every(key => declared.includes(key)),
        `runtime keys beyond the declaration: ${runtime.filter(key => !declared.includes(key)).join(', ')}`)
      // ≈: and the declaration is fully implemented — a declared-but-missing
      // member would show the host "unsupported" for a capability the bundle
      // claims.
      assert.deepEqual([...runtime].sort(), [...declared].sort())
      // No vocabulary-foreign key slipped in either.
      assert.ok(runtime.every(key => CAPABILITY_VOCABULARY.includes(key)))
    } finally {
      await session.dispose().catch(() => {})
    }
  } finally {
    // The stub CLI exits on stdin EOF but can lag behind dispose() — Windows
    // refuses to remove a directory that is still some process's cwd.
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        rmSync(world, { recursive: true, force: true })
        break
      } catch (error) {
        if (error?.code !== 'EPERM' && error?.code !== 'ENOTEMPTY') throw error
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
  }
})
