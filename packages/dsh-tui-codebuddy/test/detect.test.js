// Black-box tests for `backend.detect()` at the handler export surface.
//
// The tests run detect() inside synthetic worlds: a temp dir injected as PATH
// that contains a fake `codebuddy.cmd` (the shape npm's global shim actually
// installs on Windows), and an empty temp PATH (CLI absent). No injection seam
// is added to the API: detect() must consult the ambient `process.env.PATH`
// because that is exactly what "the CLI on the user's PATH" means.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backend } from '../backend.js'

const FAKE_VERSION = '2.186.0-fake'
const INSTALL_CHANNEL = 'npm install -g @tencent-ai/codebuddy-code'

/** Swap `process.env.PATH` for the duration of `run` and clean the temp world up. */
async function inWorld(pathDir, run) {
  const savedPath = process.env.PATH
  process.env.PATH = pathDir
  try {
    return await run()
  } finally {
    process.env.PATH = savedPath
    rmSync(pathDir, { recursive: true, force: true })
  }
}

/** Minimal BackendHost stand-in: detect() must feature-detect everything. */
function host(locale) {
  return {
    cwd: process.cwd(),
    ...(locale === undefined ? {} : { locale: () => locale }),
    debug() {},
    warn() {},
  }
}

test('detect finds a fake codebuddy.cmd injected via PATH and reports its version', async () => {
  const world = mkdtempSync(join(tmpdir(), 'codebuddy-detect-fake-'))
  // The npm global shim on Windows is a .cmd batch file; a plain execFile of
  // the bare name must not be the only strategy detect() tries.
  writeFileSync(join(world, 'codebuddy.cmd'), `@echo off\r\necho ${FAKE_VERSION}\r\n`)
  await inWorld(world, async () => {
    const result = await backend.detect(host('zh'))
    assert.equal(result.installed, true)
    assert.equal(result.version, FAKE_VERSION)
  })
})

test('detect in a world without the CLI returns installed:false with a bilingual hint and never throws', async () => {
  const world = mkdtempSync(join(tmpdir(), 'codebuddy-detect-empty-'))
  await inWorld(world, async () => {
    for (const locale of ['zh', 'en']) {
      const result = await backend.detect(host(locale))
      assert.equal(result.installed, false, `locale ${locale}`)
      assert.equal(result.version, undefined, `locale ${locale}`)
      assert.equal(typeof result.hint, 'string', `locale ${locale}`)
      assert.ok(result.hint.length > 0, `hint must not be empty (locale ${locale})`)
      // The hint must name the install channel in both languages.
      assert.ok(result.hint.includes(INSTALL_CHANNEL), `hint must name the install channel (locale ${locale}): ${result.hint}`)
    }
    // host absent → default locale (zh per docs §8 LocalizedText convention).
    const result = await backend.detect(undefined)
    assert.equal(result.installed, false)
    assert.equal(typeof result.hint, 'string')
    assert.ok(result.hint.length > 0)
  })
})
