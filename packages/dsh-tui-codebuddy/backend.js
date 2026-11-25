/**
 * Entry module of the dsh-tui-codebuddy bundle.
 *
 * Written against the published surface only: no `@deepseek-ai/*` import, no
 * dsh-TUI `src/` import. The host resolves this module through the Loader's own
 * ESM resolver and only imports it when a session actually selects the backend,
 * so nothing here may have a side effect at import time.
 *
 * MVP scope (see docs/decisions.md): streaming query, event translation,
 * canUseTool approvals, --resume, interrupt(). Capabilities declared:
 * permissions, models, images. Everything else stays undeclared until it works.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { codebuddyText, localeOf } from './text.js'
import { createCodebuddySession } from './session.js'
import { createCodebuddyPrefs } from './prefs.js'

const run = promisify(execFile)

const CLI_NAME = 'codebuddy'
const VERSION_FLAG = '--version'
const DETECT_TIMEOUT_MS = 10_000

/**
 * Windows reality: npm installs the global CLI as a `codebuddy.cmd` batch shim
 * (plus a sh wrapper and a .ps1). Node refuses to spawn `.cmd`/`.bat` without a
 * shell, and `CreateProcess` never does PATHEXT resolution for a bare name, so
 * a bare `execFile('codebuddy')` fails even on a machine where the CLI works
 * in every terminal. The reliable chain is:
 *   1. `where.exe codebuddy` (a real .exe, spawned directly) resolves PATH +
 *      PATHEXT for us — prefer the `.exe`, else the `.cmd`/`.bat` shim;
 *   2. run the resolved file: `.exe` directly, a `.cmd`/`.bat` through cmd.exe
 *      with the path quoted ourselves (spaces in `%APPDATA%\npm` paths);
 *   3. if resolution found nothing runnable, one last bare-name probe through
 *      cmd.exe (PATH + PATHEXT) covers exotic layouts;
 *   4. anything that still fails or times out is an `installed:false` hint —
 *      detect is a detection, never a throw.
 */
const CMD_WRAPPER_RE = /\.(cmd|bat)$/i
const EXECUTABLE_RE = /\.(exe|cmd|bat)$/i

/** `where.exe` next to the system root; falls back to the bare name, which
 *  `CreateProcess` still finds in System32 regardless of PATH. */
function whereExePath() {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const candidate = join(systemRoot, 'System32', 'where.exe')
  return existsSync(candidate) ? candidate : 'where.exe'
}

/** Absolute paths where the CLI name resolves on PATH/PATHEXT, best first. */
async function locateCliOnPath() {
  const { stdout } = await run(whereExePath(), [CLI_NAME], {
    timeout: DETECT_TIMEOUT_MS,
    windowsHide: true,
  })
  const ranked = stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => EXECUTABLE_RE.test(line))
    .sort((a, b) => rankOf(b) - rankOf(a))
  return ranked[0]
}

const rankOf = file => (/\.exe$/i.test(file) ? 2 : CMD_WRAPPER_RE.test(file) ? 1 : 0)

/** cmd.exe with `/d /s /c`: `/s` strips the outer quotes Node adds, so the
 *  inner quotes keep a path with spaces intact. Args are fixed constants —
 *  never user input — so embedding them is safe. */
function runThroughCmd(commandLine) {
  const comspec = process.env.comspec || 'cmd.exe'
  return run(comspec, ['/d', '/s', '/c', commandLine], {
    timeout: DETECT_TIMEOUT_MS,
    windowsHide: true,
    windowsVerbatimArguments: true,
  })
}

/** First non-empty line of a command's stdout, or undefined. */
function firstNonEmptyLine(stdout) {
  return stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line !== '')
}

async function readCliVersion(file) {
  if (!CMD_WRAPPER_RE.test(file)) {
    const { stdout } = await run(file, [VERSION_FLAG], {
      timeout: DETECT_TIMEOUT_MS,
      windowsHide: true,
    })
    return firstNonEmptyLine(stdout)
  }
  const { stdout } = await runThroughCmd(`"${file}" ${VERSION_FLAG}`)
  return firstNonEmptyLine(stdout)
}

/** Windows fallback when nothing runnable was resolved: let cmd.exe do the
 *  PATH + PATHEXT resolution on the bare name. */
async function readCliVersionByPathLookup() {
  const { stdout } = await runThroughCmd(`${CLI_NAME} ${VERSION_FLAG}`)
  return firstNonEmptyLine(stdout)
}

function detectResult(version) {
  // The command exited 0, so the CLI is there; an odd build may print nothing.
  return version === undefined ? { installed: true } : { installed: true, version }
}

function hintResult(locale) {
  return { installed: false, hint: codebuddyText('hint-cli-missing', locale) }
}

/** Detect the user-installed `codebuddy` CLI. Never throws: an unavailable
 *  state is a detection, not a failure. The locale read (live, hostile-proof)
 *  is the shared localeOf from text.js — the same helper session.js uses. */
export async function detect(host) {
  try {
    if (process.platform === 'win32') {
      const resolved = await locateCliOnPath().catch(() => undefined)
      const version = resolved !== undefined
        ? await readCliVersion(resolved)
        : await readCliVersionByPathLookup()
      return detectResult(version)
    }
    const { stdout } = await run(CLI_NAME, [VERSION_FLAG], {
      timeout: DETECT_TIMEOUT_MS,
      windowsHide: true,
    })
    return detectResult(firstNonEmptyLine(stdout))
  } catch {
    return hintResult(localeOf(host))
  }
}

/** Open a real CodeBuddy session: one long-lived streaming `query()` per
 *  session (session.js). Resume targets replay the persisted history through
 *  the same translator (one-shot history() seed) and then join the live
 *  stream with continuous numbering; unknown ids and CLI failures fail
 *  loudly — never a silent fallback to a new session. */
export async function open(target, host) {
  return createCodebuddySession(target, host)
}

/** Bare `--resume` memory + the user-facing resume command (notes §2).
 *  `sessionPrefs` is called by the launcher before any session opens and
 *  shares its store with the sessions opened on the same host. */
export const launch = {
  sessionPrefs(host) {
    return createCodebuddyPrefs(host)
  },
  resumeCommand(sessionId) {
    return `codebuddy --resume ${sessionId}`
  },
}

export const backend = {
  id: 'codebuddy',
  descriptor: { label: 'CodeBuddy' },
  detect,
  open,
  launch,
}

/** A bundle is a Cordis plugin package; this one contributes no row, so its
 *  default export does nothing. */
export default function dshTuiCodebuddyBundle() {}
