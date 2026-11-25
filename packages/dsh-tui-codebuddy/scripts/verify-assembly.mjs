#!/usr/bin/env node
/**
 * verify-assembly.mjs — drive the REAL dsh-TUI assembly chain (declaration →
 * admission → registration → picker entry → lazy load → detect) against this
 * bundle, using the driver pattern proven by the host's own
 * scripts/verify-backend-assembly.ts (host-surface notes §6):
 *
 *   1. a one-shot temp profile whose package.json lists this bundle in
 *      `dsh.profile.bundles`;
 *   2. the bundle junctioned into the profile's node_modules (no copy, so the
 *      verified bytes are the working-tree bytes);
 *   3. Context + Loader + the backend registry/assembly imported from the
 *      dsh-TUI clone at DSH_TUI_REPO (default D:/code_project/github-proj/dsh-TUI),
 *      which is only ever READ — never written.
 *
 * Zero new dependencies: the clone's TS sources are loaded through the clone's
 * own tsx (registered programmatically), its published cordis/loader through
 * its own node_modules. Import order matters: fake-home first, exactly like the
 * host script — the effect ledger and DATA_DIR resolve the home dir at import
 * time.
 *
 * Run from anywhere:  node packages/dsh-tui-codebuddy/scripts/verify-assembly.mjs
 * Success: one PASS line per check, final `verify-assembly ALL PASS`, exit 0.
 * Failure: FAIL lines, final `verify-assembly N FAILED`, exit 1.
 */

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { VALIDATED_BUNDLED_CLI_VERSION } from '../contract.js'

const BUNDLE_NAME = 'dsh-tui-codebuddy'
const BACKEND_ID = 'codebuddy'
const BUNDLE_DIR = fileURLToPath(new URL('..', import.meta.url))
const REPO = resolve(process.env.DSH_TUI_REPO ?? 'D:/code_project/github-proj/dsh-TUI')

let failed = 0
let passed = 0
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (ok || extra === '' ? '' : '  (' + extra + ')'))
  if (ok) passed += 1
  else failed += 1
}

function finish() {
  if (failed === 0) {
    console.log(`verify-assembly ALL PASS (${passed} checks)`)
    process.exit(0)
  }
  console.log(`verify-assembly ${failed} FAILED`)
  process.exit(1)
}

try {
  // ── 0. The clone must be there (read-only usage, per the boundary rules).
  const fakeHomePath = join(REPO, 'scripts', 'lib', 'fake-home.mjs')
  const assemblySrc = join(REPO, 'src', 'dsh-adapter', 'backend-assembly.ts')
  check('dsh-TUI clone found at DSH_TUI_REPO', existsSync(fakeHomePath) && existsSync(assemblySrc), REPO)

  // ── 1. Load the clone's tsx BEFORE importing any of its TS sources — as a
  //       plain module (the programmatic equivalent of `node --import tsx/esm`;
  //       loading it through module.register() instead makes tsx refuse).
  const repoRequire = createRequire(join(REPO, 'package.json'))
  await import(pathToFileURL(repoRequire.resolve('tsx/esm')).href)

  // ── 2. fake-home first: the host resolves ~/.dsh-tui at import time.
  await import(pathToFileURL(fakeHomePath).href)

  // ── 3. Host composition pieces from the clone's own node_modules.
  const { Context } = await import(pathToFileURL(repoRequire.resolve('@deepseek-ai/cordis')).href)
  const { default: Loader } = await import(pathToFileURL(repoRequire.resolve('@deepseek-ai/cordis-plugin-loader')).href)

  // ── 4. The assembly + registry from the clone's src (tsx reads TS directly).
  const { assembleBackendsFromProfile } = await import(pathToFileURL(assemblySrc).href)
  const { listBackends, listOfferedBackends, loadBackend, parseBackendChoice, unloadBackends }
    = await import(pathToFileURL(join(REPO, 'src', 'dsh-adapter', 'backend-registry.ts')).href)

  // ── 5. One-shot profile: manifest lists this bundle, junction into node_modules.
  const dir = mkdtempSync(join(tmpdir(), 'codebuddy-verify-assembly-'))
  const profileDir = join(dir, 'profile')
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'verify-codebuddy-profile',
    private: true,
    dsh: { profile: { bundles: [BUNDLE_NAME], patchReload: 'live' } },
  }, null, 2))
  const linkPath = join(profileDir, 'node_modules', BUNDLE_NAME)
  symlinkSync(BUNDLE_DIR, linkPath, process.platform === 'win32' ? 'junction' : 'dir')

  try {
    // ── 6. A real Cordis composition: Loader on the profile baseUrl, no plugin rows.
    const warnings = []
    const root = new Context()
    root.logger.warn = message => warnings.push(String(message))
    root.baseUrl = pathToFileURL(profileDir).href + '/'
    await root.plugin(Loader, { baseUrl: root.baseUrl })

    // ── 7. Assembly: declaration → admission → registration, before any parse.
    const assembled = assembleBackendsFromProfile(root)
    check('profile assembly scanned this bundle', assembled.scanned.includes(BUNDLE_NAME), JSON.stringify(assembled))
    check('registered includes codebuddy', assembled.registered.includes(BACKEND_ID), JSON.stringify(assembled.registered))
    check('no refusals', assembled.refused.length === 0, JSON.stringify(assembled.refused))
    check('no host warnings', warnings.length === 0, warnings.join(' | '))

    const entry = listBackends().find(candidate => candidate.id === BACKEND_ID)
    check('registry entry exists', entry !== undefined)

    // ── 8. The fixed facts of a third-party entry.
    check('admission decision compatible', entry?.admission?.decision === 'compatible', JSON.stringify(entry?.admission))
    check('inTree false', entry?.manifest?.inTree === false)

    const declaration = JSON.parse(readFileSync(join(BUNDLE_DIR, 'dsh-plugin.json'), 'utf8'))
    const spec = declaration.contributes['x-dsh-tui'][0].spec
    const label = entry?.manifest?.label
    check(
      'label is a literal and matches the declaration',
      label?.kind === 'literal' && typeof label.text === 'string' && label.text === spec.label.text && label.text.length <= 48,
      JSON.stringify(label),
    )
    check('shortLabel matches the declaration', entry?.manifest?.shortLabel === spec.shortLabel, JSON.stringify(entry?.manifest?.shortLabel))
    check('offered to the picker (not waiting_authorization)', listOfferedBackends().some(candidate => candidate.id === BACKEND_ID))
    check('parseBackendChoice now accepts the id (assembly precedes parse)', parseBackendChoice(BACKEND_ID) === BACKEND_ID)

    // ── 9. Lazy load through the registry: import + handler assertion + detect.
    let detection
    try {
      const handler = await loadBackend(BACKEND_ID)
      check('handler id equals spec.id', handler.id === BACKEND_ID, String(handler.id))
      // Minimal BackendHost stand-in; detect() must feature-detect everything.
      detection = await handler.detect({
        cwd: profileDir,
        locale: () => 'zh',
        debug() {},
        warn() {},
      })
    } catch (error) {
      check('loadBackend + detect never throw', false, error instanceof Error ? error.message : String(error))
    }
    check('detect returns { installed: boolean }', typeof detection?.installed === 'boolean', JSON.stringify(detection))
    check(
      'detect result is a detection, never a dead end',
      detection?.installed === true
        ? typeof detection.version === 'string' && detection.version.length > 0
        : typeof detection?.hint === 'string' && detection.hint.length > 0,
      JSON.stringify(detection),
    )
    // Version honesty (code-review fix): detect.version stays the PATH CLI's
    // measured value, and the detection also carries the SDK-bundled CLI
    // fact — the version the session will ACTUALLY run (which may differ).
    check(
      'detect carries the bundled CLI fact with a bilingual note',
      detection?.bundledCliVersion === VALIDATED_BUNDLED_CLI_VERSION
        && typeof detection?.note === 'string' && detection.note.includes(VALIDATED_BUNDLED_CLI_VERSION),
      JSON.stringify(detection),
    )

    // ── 10. Exit funnel: pool hook + composition teardown resolve.
    try {
      await unloadBackends()
      check('unloadBackends resolves', true)
    } catch (error) {
      check('unloadBackends resolves', false, error instanceof Error ? error.message : String(error))
    }
    await root.fiber.dispose()

    console.log(`detection evidence: ${JSON.stringify(detection)}`)
  } finally {
    // Remove the junction link itself first (lstat-checked), then the temp dir;
    // rmSync on a junction unlinks the link and never follows into the bundle.
    try {
      if (lstatSync(linkPath).isSymbolicLink()) rmSync(linkPath, { recursive: true, force: true })
    } catch { /* already gone */ }
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  }
} catch (error) {
  check('verify-assembly driver', false, error instanceof Error ? error.stack : String(error))
} finally {
  finish()
}
