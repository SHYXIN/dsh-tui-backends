#!/usr/bin/env node
/**
 * verify-contract.mjs — the anti-drift gate (ticket T6), in the claude
 * backend's verify-contract posture: the version contract (contract.js) must
 * agree with the package manifest AND the lockfile, and the pinned SDK must
 * still look like the package the translator was written against.
 *
 * Checks:
 *   1. contract ↔ package.json — the dependency pin matches VALIDATED_SDK_VERSION.
 *   2. contract ↔ lockfile — the workspace importer pins specifier+version to
 *      the same version (three-way agreement, contract included).
 *   3. smoke import — the SDK resolves and every key export in
 *      SDK_KEY_EXPORTS exists at runtime (a restructured package fails here,
 *      not in production).
 *   4. bundled CLI — the SDK's own cli/package.json still declares the
 *      validated @tencent-ai/codebuddy-code version.
 *   5. contract ↔ dsh-plugin.json — the manifest's spec id / capabilities /
 *      grants match the frozen declaration.
 *
 * Run: node packages/dsh-tui-codebuddy/scripts/verify-contract.mjs
 * Success: PASS lines + `verify-contract ALL PASS (N checks)`, exit 0.
 * Failure: FAIL lines + `verify-contract N FAILED`, exit 1.
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DECLARED_CAPABILITIES,
  SDK_KEY_EXPORTS,
  SDK_PACKAGE,
  VALIDATED_BUNDLED_CLI_PACKAGE,
  VALIDATED_BUNDLED_CLI_VERSION,
  VALIDATED_SDK_VERSION,
} from '../contract.js'

const BUNDLE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let failed = 0
let passed = 0
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (ok || extra === '' ? '' : '  (' + extra + ')'))
  if (ok) passed += 1
  else failed += 1
}

function finish() {
  if (failed === 0) {
    console.log(`verify-contract ALL PASS (${passed} checks)`)
    process.exit(0)
  }
  console.log(`verify-contract ${failed} FAILED`)
  process.exit(1)
}

try {
  // ── 1. contract ↔ package.json ──────────────────────────────────────────
  const bundlePkg = JSON.parse(readFileSync(join(BUNDLE_DIR, 'package.json'), 'utf8'))
  const pinned = bundlePkg.dependencies?.[SDK_PACKAGE]
  check(
    `package.json pins ${SDK_PACKAGE}@${VALIDATED_SDK_VERSION}`,
    pinned === VALIDATED_SDK_VERSION,
    String(pinned),
  )

  // ── 2. contract ↔ lockfile (the workspace importer's specifier+version) ─
  let lockfile = null
  for (let dir = BUNDLE_DIR; dir !== dirname(dir); dir = dirname(dir)) {
    const candidate = join(dir, 'pnpm-lock.yaml')
    if (existsSync(candidate)) { lockfile = candidate; break }
  }
  check('pnpm-lock.yaml found', lockfile !== null, String(lockfile))
  if (lockfile !== null) {
    const raw = readFileSync(lockfile, 'utf8')
    const importerHeader = 'packages/dsh-tui-codebuddy:'
    const importerAt = raw.indexOf(importerHeader)
    check('lockfile has the bundle importer block', importerAt !== -1, lockfile)
    if (importerAt !== -1) {
      const importer = raw.slice(importerAt, importerAt + 800)
      const depAt = importer.indexOf(`'${SDK_PACKAGE}':`)
      check('lockfile importer lists the SDK dependency', depAt !== -1)
      if (depAt !== -1) {
        const depBlock = importer.slice(depAt, depAt + 200)
        check(
          'lockfile specifier matches the contract version',
          depBlock.includes(`specifier: ${VALIDATED_SDK_VERSION}`),
          depBlock.split('\n').slice(0, 3).join(' | ').trim(),
        )
        check(
          'lockfile resolved version matches the contract version',
          depBlock.includes(`version: ${VALIDATED_SDK_VERSION}`),
          depBlock.split('\n').slice(0, 3).join(' | ').trim(),
        )
      }
    }
    check(
      'lockfile packages section carries the pinned SDK',
      raw.includes(`${SDK_PACKAGE.replace('/', '/')}@${VALIDATED_SDK_VERSION}`),
      `${SDK_PACKAGE}@${VALIDATED_SDK_VERSION}`,
    )
  }

  // ── 3. smoke import + key export presence ────────────────────────────────
  const req = createRequire(join(BUNDLE_DIR, 'package.json'))
  let sdkDir = null
  try {
    sdkDir = dirname(req.resolve(`${SDK_PACKAGE}/package.json`))
  } catch {
    // exports may hide ./package.json — walk up from the resolved entry
    try {
      const entry = req.resolve(SDK_PACKAGE)
      let dir = dirname(entry)
      while (dir !== dirname(dir) && !existsSync(join(dir, 'package.json'))) dir = dirname(dir)
      sdkDir = dir
    } catch {
      sdkDir = null
    }
  }
  check('the SDK resolves for import', sdkDir !== null, String(sdkDir))
  if (sdkDir !== null) {
    const mod = await import(`${SDK_PACKAGE}`)
    for (const name of SDK_KEY_EXPORTS) {
      check(`SDK export ${name} exists at runtime`, typeof mod[name] !== 'undefined', String(typeof mod[name]))
    }
    // ── 4. the bundled CLI still matches the contract ──────────────────────
    const cliPkgPath = join(sdkDir, 'cli', 'package.json')
    check('the SDK bundles a CLI package', existsSync(cliPkgPath), cliPkgPath)
    if (existsSync(cliPkgPath)) {
      const cliPkg = JSON.parse(readFileSync(cliPkgPath, 'utf8'))
      check(
        `bundled CLI is ${VALIDATED_BUNDLED_CLI_PACKAGE}@${VALIDATED_BUNDLED_CLI_VERSION}`,
        cliPkg.name === VALIDATED_BUNDLED_CLI_PACKAGE && cliPkg.version === VALIDATED_BUNDLED_CLI_VERSION,
        `${cliPkg.name}@${cliPkg.version}`,
      )
    }
  }

  // ── 5. contract ↔ dsh-plugin.json ────────────────────────────────────────
  const manifest = JSON.parse(readFileSync(join(BUNDLE_DIR, 'dsh-plugin.json'), 'utf8'))
  const spec = manifest.contributes['x-dsh-tui'][0].spec
  check('manifest spec.id matches the contract backend id', spec.id === 'codebuddy', String(spec.id))
  check(
    'manifest capabilities match the frozen declaration exactly',
    JSON.stringify([...spec.capabilities].sort()) === JSON.stringify([...DECLARED_CAPABILITIES].sort()),
    JSON.stringify(spec.capabilities),
  )
  check('manifest grants stay empty (host admission rule)', Array.isArray(spec.grants) && spec.grants.length === 0, JSON.stringify(spec.grants))
} catch (error) {
  check('verify-contract driver', false, error instanceof Error ? error.stack : String(error))
} finally {
  finish()
}
