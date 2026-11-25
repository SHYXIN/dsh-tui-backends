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
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Detect the user-installed `codebuddy` CLI. Never throws: an unavailable
 *  state is a detection, not a failure. */
export async function detect() {
  try {
    const { stdout } = await run('codebuddy', ['--version'], { timeout: 15_000 })
    const version = stdout.trim().split('\n')[0]?.trim()
    return { installed: Boolean(version), version }
  } catch {
    return {
      installed: false,
      hint: 'codebuddy CLI not found on PATH — install it via npm (npm i -g @tencent-ai/codebuddy-code) or see https://www.codebuddy.ai/docs/cli/cli-reference',
    }
  }
}

/** Not implemented yet — the MVP session lands next (docs/decisions.md). */
export async function open() {
  throw new Error('dsh-tui-codebuddy: session implementation not started yet (MVP scope in docs/decisions.md)')
}

export const backend = {
  id: 'codebuddy',
  descriptor: { label: 'CodeBuddy' },
  detect,
  open,
}

/** A bundle is a Cordis plugin package; this one contributes no row, so its
 *  default export does nothing. */
export default function dshTuiCodebuddyBundle() {}
