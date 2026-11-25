/**
 * Fake codebuddy CLI — a node script the REAL @tencent-ai/agent-sdk spawns as
 * the CLI subprocess in behavior tests (CODEBUDDY_CODE_PATH injection, the
 * seam agreed in docs/decisions.md). It speaks just enough stream-json:
 *
 *  - answers every control_request (the initialize handshake has a 60s
 *    timeout in the SDK — a stub that stays silent wedges the session);
 *  - replays a per-turn script (init → assistant/stream_event frames →
 *    result) driven by a scenario JSON, with a plain echo turn as fallback;
 *  - exits as soon as stdin hits EOF, so the SDK's Windows-side 8s backstop
 *    kill never fires and dispose() proves itself graceful.
 *
 * Environment:
 *   CB_FAKE_SCRIPT      scenario JSON path (optional; default = echo turns)
 *   CB_FAKE_MARKER_DIR  dir receiving `stub-start-<pid>` / `stub-exit-<pid>` /
 *                       `stub-interrupt-<pid>` marker files, the explicit
 *                       no-dangling-handle / signal-arrival evidence
 *
 * Scenario shape:
 *   { "sessionId"?: string, "model"?: string,
 *     "exitAfterFirstUser"?: boolean,             // die mid-turn, never result
 *     "afterInit"?: Frame[],                       // emitted once after init
 *     "turns"?: [{ "frames"?: Frame[],             // emitted on the Nth user message
 *                 "resultDelayMs"?: number,        // delay before the default result
 *                 "interruptResult"?: 'none' }] }  // ack interrupt, never emit result
 * Frames are written verbatim; `uuid` / `session_id` are default-filled.
 *
 * Interrupt lines (ticket T4):
 *  - default: an interrupt control request arriving mid-run cancels the
 *    pending delayed result and emits the interrupted-form result EARLY —
 *    subtype:'success', is_error:false, terminal_reason:'interrupt',
 *    result:'' (the shape the docs promise for a cancelled turn);
 *  - `interruptResult:'none'`: the interrupt is ACKNOWLEDGED (control
 *    response, like the real CLI) but no result ever follows — the
 *    "CLI never replies with a result" line that exercises the session's
 *    force-settle backstop;
 *  - every interrupt writes the `stub-interrupt-<pid>` marker FIRST, so tests
 *    can prove the signal physically reached the CLI process.
 */
import readline from 'node:readline'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const markerDir = process.env.CB_FAKE_MARKER_DIR
function mark(kind) {
  if (!markerDir) return
  try {
    writeFileSync(join(markerDir, `stub-${kind}-${process.pid}`), String(process.pid))
  } catch {
    // evidence is best-effort; never break the stub over it
  }
}

let scenario = {}
try {
  const path = process.env.CB_FAKE_SCRIPT
  if (path) scenario = JSON.parse(readFileSync(path, 'utf8'))
} catch {
  scenario = {}
}

const requestedSessionId = (() => {
  const flagIndex = process.argv.indexOf('--session-id')
  return flagIndex !== -1 ? process.argv[flagIndex + 1] : undefined
})()

const sessionId = requestedSessionId ?? scenario.sessionId ?? 'stub-session-0001'
const model = scenario.model ?? 'stub-model'

let uuidCounter = 0
const nextUuid = () => `u-${String(++uuidCounter).padStart(4, '0')}`

function out(frame) {
  const filled = {
    uuid: nextUuid(),
    session_id: sessionId,
    ...frame,
  }
  try {
    process.stdout.write(JSON.stringify(filled) + '\n')
  } catch {
    // consumer gone — nothing left to tell
  }
}

// 1) init system message (shape aligned with the SDK's SystemMessage).
out({
  type: 'system',
  subtype: 'init',
  apiKeySource: 'none',
  cwd: process.cwd(),
  tools: ['Read', 'Write', 'Bash'],
  mcp_servers: [],
  model,
  permissionMode: 'default',
  slash_commands: [],
  codebuddy_code_version: '2.186.0-stub',
})
mark('start')

for (const frame of scenario.afterInit ?? []) out(frame)

// ── turn scripts ──────────────────────────────────────────────────────────────
let cumulativeInput = 0
let cumulativeOutput = 0
let turnOpen = false
let resultTimer = null
let currentScript = null // the scenario script of the turn in flight
let userTurnsSeen = 0

/** A bare assistant frame (no result) — used by the die-mid-turn line. */
function assistantFrameOnly(text) {
  out({
    type: 'assistant', parent_tool_use_id: null,
    message: { id: `msg_${uuidCounter + 1}`, type: 'message', role: 'assistant', model,
      content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 } },
  })
}

function defaultResult(extra = {}) {
  cumulativeInput += 10
  cumulativeOutput += 5
  out({
    type: 'result',
    subtype: 'success',
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: extra.resultText ?? 'done',
    total_cost_usd: 0.01,
    usage: { input_tokens: cumulativeInput, output_tokens: cumulativeOutput },
    permission_denials: [],
    ...extra.frame,
  })
  turnOpen = false
  resultTimer = null
}

function emitEchoTurn(userText) {
  const full = `echo: ${userText}`
  out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: `msg_${uuidCounter + 1}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } } })
  out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'echo: ' } } })
  out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: userText } } })
  out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_stop', index: 0 } })
  out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } } })
  out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } })
  out({
    type: 'assistant', parent_tool_use_id: null,
    message: { id: `msg_${uuidCounter + 1}`, type: 'message', role: 'assistant', model,
      content: [{ type: 'text', text: full }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 } },
  })
  defaultResult({ resultText: full })
}

function emitScriptTurn(script) {
  turnOpen = true
  let sawResult = false
  for (const frame of script.frames ?? []) {
    if (frame?.type === 'result') sawResult = true
    out(frame)
  }
  if (sawResult) {
    turnOpen = false
    return
  }
  const delay = script.resultDelayMs
  if (typeof delay === 'number' && delay > 0) {
    // Leave the turn hanging until the delay or an interrupt — lets tests
    // cancel/steer mid-turn deterministically.
    resultTimer = setTimeout(() => defaultResult(), delay)
    return
  }
  defaultResult()
}

function startTurn(userText) {
  turnOpen = true
  userTurnsSeen += 1
  if (scenario.exitAfterFirstUser === true && userTurnsSeen === 1) {
    // "CLI dies mid-turn" line: one assistant frame proves the turn was in
    // flight, then the process exits without ever emitting a result.
    assistantFrameOnly('dying mid-turn')
    mark('exit')
    setTimeout(() => process.exit(0), 30) // let the stdout write flush first
    return
  }
  const script = (scenario.turns ?? []).shift()
  currentScript = script
  if (script === undefined) return emitEchoTurn(userText)
  emitScriptTurn(script)
}

// ── control requests: always answer, or the SDK's 60s timeout fires ──────────
function handleControlRequest(line) {
  const { request_id: requestId, request } = line
  switch (request?.subtype) {
    case 'initialize':
      out({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response: {
            commands: [],
            models: [{ value: model, displayName: 'Stub model', description: '' }],
            account: {},
          },
        },
      })
      break
    case 'interrupt': {
      // Evidence first: the interrupt signal physically reached the CLI.
      mark('interrupt')
      // The real CLI acks the interrupt control request; the RESULT frame is
      // the only turn-level receipt there is — an ack must never be read as
      // one by the session (T4 receipt semantics).
      out({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: {} } })
      if (currentScript?.interruptResult === 'none') break // never replies — backstop line
      if (resultTimer !== null) clearTimeout(resultTimer)
      resultTimer = null
      if (turnOpen) defaultResult({ frame: { terminal_reason: 'interrupt', result: '' } })
      break
    }
    default:
      // set_permission_mode / set_model / mcp_status / …: success, empty payload
      out({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: {} } })
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity })
rl.on('line', raw => {
  if (!raw.trim()) return
  let line
  try {
    line = JSON.parse(raw)
  } catch {
    return // non-JSON stdin noise is ignored, like the real CLI
  }
  if (line.type === 'control_request') return handleControlRequest(line)
  if (line.type === 'user') {
    const content = line.message?.content
    const text = typeof content === 'string' ? content : '(blocks)'
    startTurn(text)
  }
})
rl.on('close', () => {
  mark('exit')
  process.exit(0) // EOF → immediate exit: the SDK's 8s Windows backstop never fires
})
