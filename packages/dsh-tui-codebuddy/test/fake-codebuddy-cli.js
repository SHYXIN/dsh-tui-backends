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
 *                       `stub-interrupt-<pid>` marker files (no-dangling-handle
 *                       + signal-arrival evidence) plus
 *                       `stub-perm-responses.jsonl` — every can_use_tool
 *                       control_response the stub received, the black-box
 *                       record of what the SDK answered on the wire
 *
 * Scenario shape:
 *   { "sessionId"?: string, "model"?: string,
 *     "exitAfterFirstUser"?: boolean,             // die mid-turn, never result
 *     "afterInit"?: Frame[],                       // emitted once after init
 *     "turns"?: [{ "frames"?: Frame[],             // emitted on the Nth user message
 *                 "resultDelayMs"?: number,        // delay before the default result
 *                 "interruptResult"?: 'none' }] }  // ack interrupt, never emit result
 *     "resume"?: {                                 // only consulted with --resume in argv
 *       "sessionId"?: string,                      // session id declared at the handshake
 *       "unknownSession"?: true,                   // exit non-zero immediately: not found
 *       "historyDelayMs"?: number,                 // pacing between history turns
 *       "history"?: [{ "user": string,             // historical user message (text)
 *                     "assistant"?: Block[],       // assistant message after the user row
 *                     "toolResult"?: { "toolUseId", "content"?, "isError"? },
 *                     "assistant2"?: Block[] }] }  // assistant message after the tool result
 *   }
 * Every history turn is closed with a result frame (the CLI replays each
 * historical turn to its terminal state — credits-doc evidence: replayed
 * results exist and carry no turnUsage). Frames are written verbatim;
 * `uuid` / `session_id` are default-filled.
 *
 * One frame kind is intercepted instead of written:
 *   { "type": "_permission_gate", "toolUseId", "toolName", "input",
 *     "resultText"? } — emits the tool_use assistant frame, then a real
 *   can_use_tool control request, and holds the script until the SDK's
 *   control_response arrives (allowed → the tool result; denied → an error
 *   tool result carrying the reason, like a CLI reporting a refusal).
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
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const markerDir = process.env.CB_FAKE_MARKER_DIR
function mark(kind, code) {
  if (!markerDir) return
  try {
    // Exit markers carry the exit code as content — the loud-failure evidence.
    writeFileSync(join(markerDir, `stub-${kind}-${process.pid}`), code !== undefined ? String(code) : String(process.pid))
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

// ── resume script (ticket T5): the SDK passes `--resume <id>` on the argv ────
const resumeFlagIndex = process.argv.indexOf('--resume')
const resumeTargetId = resumeFlagIndex !== -1 ? process.argv[resumeFlagIndex + 1] : undefined
const resumeSpec = resumeTargetId !== undefined ? (scenario.resume ?? {}) : null

if (resumeSpec?.unknownSession === true) {
  // 指定会话不存在：CLI 响亮退出（非零），绝不静默回落新会话。
  mark('exit', 1)
  process.stderr.write(`codebuddy stub: session ${resumeTargetId} not found\n`)
  process.exit(1)
}

const sessionId = resumeSpec !== null
  ? (resumeSpec.sessionId ?? resumeTargetId) // the handshake declares the resumed id
  : (requestedSessionId ?? scenario.sessionId ?? 'stub-session-0001')
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

// ── resume history replay: handshake declares the id → history lines → live ──
function emitHistoryTurn(turnSpec, index) {
  out({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: turnSpec.user ?? '' } })
  if (Array.isArray(turnSpec.assistant) && turnSpec.assistant.length > 0) {
    out({
      type: 'assistant', parent_tool_use_id: null,
      message: { id: `msg_h${index}a`, type: 'message', role: 'assistant', model,
        content: turnSpec.assistant, stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 } },
    })
  }
  if (turnSpec.toolResult) {
    const tr = turnSpec.toolResult
    out({
      type: 'user', parent_tool_use_id: null,
      message: { role: 'user', content: [{
        type: 'tool_result', tool_use_id: tr.toolUseId, content: tr.content ?? '',
        ...(tr.isError === true ? { is_error: true } : {}),
      }] },
    })
  }
  if (Array.isArray(turnSpec.assistant2) && turnSpec.assistant2.length > 0) {
    out({
      type: 'assistant', parent_tool_use_id: null,
      message: { id: `msg_h${index}b`, type: 'message', role: 'assistant', model,
        content: turnSpec.assistant2, stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 } },
    })
  }
  defaultResult({ resultText: turnSpec.user ?? '' })
}

// ── turn scripts ──────────────────────────────────────────────────────────────
let cumulativeInput = 0
let cumulativeOutput = 0
let turnOpen = false
let resultTimer = null
let currentScript = null // the scenario script of the turn in flight
let userTurnsSeen = 0
const turnDenials = []
let permissionSeq = 0
const pendingGates = new Map() // request_id → { toolUseId, toolName, input }
const pendingGateWaits = new Map() // request_id → resolve() of the parked script

/** A bare assistant frame (no result) — used by the die-mid-turn line. */
function assistantFrameOnly(text) {
  out({
    type: 'assistant', parent_tool_use_id: null,
    message: { id: `msg_${uuidCounter + 1}`, type: 'message', role: 'assistant', model,
      content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 } },
  })
}

function recordPermissionResponse(requestId, gate, response) {
  if (!markerDir) return
  try {
    appendFileSync(join(markerDir, 'stub-perm-responses.jsonl'), `${JSON.stringify({
      requestId,
      toolUseId: gate?.toolUseId,
      allowed: response?.allowed === true,
      reason: typeof response?.reason === 'string' ? response.reason : undefined,
      hasUpdatedPermissions: Object.hasOwn(response ?? {}, 'updatedPermissions'),
    })}\n`)
  } catch {
    // evidence is best-effort; never break the stub over it
  }
}

/** The permission gate: a real CLI→SDK can_use_tool control request, answered
 *  by whatever the session's approval loop decides. */
function requestPermissionGate(gate) {
  permissionSeq += 1
  const requestId = `stub-perm-${permissionSeq}`
  pendingGates.set(requestId, gate)
  out({
    type: 'control_request',
    request_id: requestId,
    request: {
      subtype: 'can_use_tool',
      tool_name: gate.toolName,
      input: gate.input,
      tool_use_id: gate.toolUseId,
    },
  })
  return requestId
}

/** A gate got its answer: emit the matching tool result — unless the turn was
 *  already closed (interrupt/dispose), when the answer arrives too late. */
function resolvePermissionGate(requestId, response) {
  const gate = pendingGates.get(requestId)
  pendingGates.delete(requestId)
  recordPermissionResponse(requestId, gate, response)
  if (gate === undefined || !turnOpen) return
  if (response?.allowed === true) {
    out({
      type: 'user', parent_tool_use_id: gate.toolUseId,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: gate.toolUseId, content: gate.resultText ?? 'ok' }] },
    })
  } else {
    turnDenials.push({ tool_name: gate.toolName, tool_use_id: gate.toolUseId, tool_input: gate.input })
    out({
      type: 'user', parent_tool_use_id: gate.toolUseId,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: gate.toolUseId, content: `Permission denied: ${response?.reason ?? 'no reason given'}`, is_error: true }] },
    })
  }
  pendingGateWaits.get(requestId)?.()
  pendingGateWaits.delete(requestId)
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
    permission_denials: turnDenials.splice(0),
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

async function emitScriptTurn(script) {
  turnOpen = true
  let sawResult = false
  for (const frame of script.frames ?? []) {
    if (frame?.type === 'result') sawResult = true
    if (frame?.type === '_permission_gate') {
      // Emit the tool_use assistant frame, then park the script on the real
      // can_use_tool request until the SDK answers.
      out({
        type: 'assistant', parent_tool_use_id: null,
        message: { id: `msg_${uuidCounter + 1}`, type: 'message', role: 'assistant', model,
          content: [{ type: 'tool_use', id: frame.toolUseId, name: frame.toolName, input: frame.input }],
          stop_reason: 'tool_use', stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 } },
      })
      const requestId = requestPermissionGate(frame)
      await new Promise(resolve => {
        pendingGateWaits.set(requestId, resolve)
      })
      continue
    }
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
  emitScriptTurn(script).catch(() => {
    // a broken scenario must not crash the stub process; the test times out
    // and shows which wait never resolved
  })
}

// The replay runs at boot, after the turn-script machinery is initialized
// (defaultResult owns the cumulative usage counters).
if (resumeSpec !== null && Array.isArray(resumeSpec.history) && resumeSpec.history.length > 0) {
  const delayMs = typeof resumeSpec.historyDelayMs === 'number' ? resumeSpec.historyDelayMs : 0
  let index = 0
  const emitNext = () => {
    emitHistoryTurn(resumeSpec.history[index], index)
    index += 1
    if (index < resumeSpec.history.length) {
      if (delayMs > 0) setTimeout(emitNext, delayMs)
      else emitNext()
    }
  }
  emitNext()
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
  if (line.type === 'control_response') {
    // The SDK's answer to one of our can_use_tool requests.
    const { request_id: requestId, response } = line.response ?? {}
    if (pendingGates.has(requestId)) resolvePermissionGate(requestId, response)
    return
  }
  if (line.type === 'user') {
    const content = line.message?.content
    const text = typeof content === 'string' ? content : '(blocks)'
    void startTurn(text) // the script may park on a permission gate
  }
})
rl.on('close', () => {
  mark('exit', 0)
  process.exit(0) // EOF → immediate exit: the SDK's 8s Windows backstop never fires
})
