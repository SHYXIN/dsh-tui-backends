/**
 * Version contract (ticket T6 — the anti-drift gate). The facts this bundle
 * was written and validated against, pinned here so a dependency bump or a
 * surface change FAILS LOUDLY instead of drifting silently. The posture
 * mirrors the claude in-tree backend's contract.ts: validated versions plus
 * the key exports the bundle actually leans on, checked three ways
 * (contract ↔ package.json ↔ lockfile) by scripts/verify-contract.mjs.
 *
 * - SDK: `@tencent-ai/agent-sdk` 0.3.307 (the version the translator's event
 *   mappings and the transport reach-throughs were verified against —
 *   codebuddy-sdk notes). Its internal SDK_VERSION string (0.3.28) is a
 *   User-Agent artifact and deliberately NOT part of this contract.
 * - CLI: the SDK bundles its own CLI (`@tencent-ai/codebuddy-code` 2.187.0),
 *   which the SDK resolves before any PATH lookup — so the CLI version rides
 *   the SDK pin (checked against the bundled cli/package.json).
 * - Capabilities: the manifest declares exactly permissions / models /
 *   images and grants nothing (host admission rules, host-surface notes §3).
 */

export const CODEBUDDY_BACKEND_ID = 'codebuddy'
export const CODEBUDDY_BACKEND_LABEL = 'CodeBuddy'

export const SDK_PACKAGE = '@tencent-ai/agent-sdk'
export const VALIDATED_SDK_VERSION = '0.3.307'

/** The CLI the validated SDK bundles (cli/package.json name + version). */
export const VALIDATED_BUNDLED_CLI_PACKAGE = '@tencent-ai/codebuddy-code'
export const VALIDATED_BUNDLED_CLI_VERSION = '2.187.0'

/** Key runtime exports whose presence pins the package identity and shape —
 *  the smoke-import list of verify-contract (value exports only; type-only
 *  names do not exist at runtime). */
export const SDK_KEY_EXPORTS = Object.freeze([
  'query',
  'Query',
  'unstable_v2_createSession',
  'unstable_v2_resumeSession',
  'unstable_v2_prompt',
  'createSdkMcpServer',
  'tool',
  'AbortError',
  'CLIStartupError',
  'ExecutionError',
  'HOOK_EVENTS',
  'EXIT_REASONS',
])

/** The capability face this MVP declares — dsh-plugin.json must match
 *  exactly (checked by verify-contract AND test/capabilities.test.js). */
export const DECLARED_CAPABILITIES = Object.freeze(['permissions', 'models', 'images'])
