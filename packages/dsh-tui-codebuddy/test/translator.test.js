// Black-box tests for the CodeBuddy protocol translator — the pure state
// machine that turns @tencent-ai/agent-sdk messages into the bundle's
// self-declared AgentEvent vocabulary (fixture approach: the shapes live here
// in the bundle, nothing is imported from dsh-TUI — host-surface notes §7B).
//
// Live and replay share this one translator (docs/decisions.md MVP item 2), so
// everything here is frame-driven: no process, no network, no SDK import.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCodebuddyTranslator, createIdentityAudit } from '../translator.js'
import { codebuddyText } from '../text.js'

const NOW = () => 1_700_000_000_000
const enText = (key, params) => codebuddyText(key, 'en', params)

/** The canonical init frame a CodeBuddy CLI emits on stream-json startup. */
function initFrame(overrides = {}) {
  return {
    type: 'system',
    subtype: 'init',
    uuid: 'u-0001',
    session_id: 'stub-session-0001',
    apiKeySource: 'none',
    cwd: 'D:/fixture/project',
    tools: ['Read', 'Write', 'Bash'],
    mcp_servers: [],
    model: 'stub-model',
    permissionMode: 'default',
    slash_commands: [],
    codebuddy_code_version: '2.186.0-stub',
    ...overrides,
  }
}

test('init frame becomes session.ready carrying the session metadata', () => {
  const translator = createCodebuddyTranslator({ cwd: 'D:/fixture/project', now: NOW })
  const events = translator.translate(initFrame())
  assert.equal(events.length, 1)
  const ready = events[0]
  assert.equal(ready.type, 'session.ready')
  assert.equal(ready.sessionId, 'stub-session-0001')
  assert.equal(ready.cwd, 'D:/fixture/project')
  assert.equal(ready.model, 'stub-model')
  assert.equal(ready.permissionMode, 'default')
  assert.equal(ready.backendVersion, '2.186.0-stub')
})

test('unknown protocol messages are ignored without crashing', () => {
  const translator = createCodebuddyTranslator({ cwd: 'D:/fixture/project', now: NOW })
  translator.translate(initFrame())
  // A frame type the SDK's own Message union does not know…
  assert.deepEqual(translator.translate({ type: 'galaxy_brain', level: 11 }), [])
  // …and a system subtype that exists on the wire but maps to nothing yet.
  assert.deepEqual(translator.translate({ type: 'system', subtype: 'usage_update', uuid: 'u-9', session_id: 'stub-session-0001' }), [])
  // …and a known type in an impossible shape (no payload at all).
  assert.deepEqual(translator.translate({ type: 'assistant' }), [])
  // The translator must still work afterwards.
  assert.deepEqual(translator.translate({ type: 'system', subtype: 'warp_drive' }), [])
})

test('identity audit accepts a well-formed event stream and rejects violations', () => {
  const audit = createIdentityAudit()
  const good = [
    { type: 'session.ready', sessionId: 's1', cwd: 'c', model: 'm' },
    { type: 'user.message', seq: 1, anchor: 'u1', id: 'u1', time: 0, source: 'user', text: 'hi', blocks: [] },
    { type: 'turn.start', turn: 1, origin: 'user', userMessageId: 'u1', time: 0 },
    { type: 'step.start', turn: 1, step: 1 },
    { type: 'assistant.attempt.start', attemptId: 'a1', turn: 1, step: 1 },
    { type: 'assistant.delta', attemptId: 'a1', index: 0, time: 0, delta: { kind: 'text', text: 'H' } },
    { type: 'assistant.delta', attemptId: 'a1', index: 1, time: 0, delta: { kind: 'text', text: 'i' } },
    { type: 'assistant.attempt.end', attemptId: 'a1', outcome: 'committed', turn: 1, step: 1 },
    { type: 'step.end', turn: 1, step: 1 },
    { type: 'assistant.message', seq: 2, anchor: 'u2', turn: 1, step: 1, attemptId: 'a1', time: 0, blocks: [], canonical: true },
    { type: 'tool.call', seq: 3, turn: 1, step: 1, callId: 'toolu_1', name: 'Bash', argsJson: '{}', time: 0 },
    { type: 'tool.result', seq: 4, turn: 1, step: 1, callId: 'toolu_1', isError: false, time: 0, content: 'ok', text: 'ok' },
    { type: 'turn.end', turn: 1, reason: { kind: 'completed' }, time: 0 },
  ]
  audit.check(good) // must not throw

  assert.throws(() => createIdentityAudit().check([{ type: 'user.message', seq: 2, anchor: 'u1', id: 'u1', time: 0, source: 'user', text: 'hi', blocks: [] }]),
    /first seq-carrying event must be seq 1/)
  assert.throws(() => createIdentityAudit().check([
    { type: 'user.message', seq: 1, anchor: 'u1', id: 'u1', time: 0, source: 'user', text: 'a', blocks: [] },
    { type: 'assistant.message', seq: 1, anchor: 'u2', turn: 1, step: 1, attemptId: 'a1', time: 0, blocks: [], canonical: true },
  ]), /seq must be contiguous/)
  assert.throws(() => createIdentityAudit().check([
    { type: 'turn.start', turn: 1, origin: 'user', time: 0 },
    { type: 'turn.start', turn: 1, origin: 'user', time: 0 },
  ]), /turn must increase/)
  assert.throws(() => createIdentityAudit().check([
    { type: 'turn.start', turn: 1, origin: 'user', time: 0 },
    { type: 'step.start', turn: 1, step: 1 },
    { type: 'assistant.attempt.start', attemptId: 'a1', turn: 1, step: 1 },
    { type: 'assistant.attempt.start', attemptId: 'a1', turn: 1, step: 1 },
  ]), /attemptId must be unique/)
  assert.throws(() => createIdentityAudit().check([
    { type: 'turn.start', turn: 1, origin: 'user', time: 0 },
    { type: 'tool.call', seq: 1, turn: 1, step: 1, callId: 't1', name: 'Bash', argsJson: '{}', time: 0 },
    { type: 'tool.call', seq: 2, turn: 1, step: 1, callId: 't1', name: 'Bash', argsJson: '{}', time: 0 },
  ]), /callId must be unique/)
})

// ── slice 2: the streaming turn ─────────────────────────────────────────────

/** Streaming burst the CLI sends for one assistant turn (Anthropic-style
 *  RawMessageStreamEvent sequence), parameterized over the text. */
function streamBurst(text) {
  return [
    { type: 'stream_event', uuid: 'se-1', session_id: 'stub-session-0001', parent_tool_use_id: null,
      event: { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'stub-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } } },
    { type: 'stream_event', uuid: 'se-2', session_id: 'stub-session-0001', parent_tool_use_id: null,
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { type: 'stream_event', uuid: 'se-3', session_id: 'stub-session-0001', parent_tool_use_id: null,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, 3) } } },
    { type: 'stream_event', uuid: 'se-4', session_id: 'stub-session-0001', parent_tool_use_id: null,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(3) } } },
    { type: 'stream_event', uuid: 'se-5', session_id: 'stub-session-0001', parent_tool_use_id: null,
      event: { type: 'content_block_stop', index: 0 } },
    { type: 'stream_event', uuid: 'se-6', session_id: 'stub-session-0001', parent_tool_use_id: null,
      event: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } } },
    { type: 'stream_event', uuid: 'se-7', session_id: 'stub-session-0001', parent_tool_use_id: null,
      event: { type: 'message_stop' } },
  ]
}

function assistantFrame(text, overrides = {}) {
  return {
    type: 'assistant', uuid: 'u-0002', session_id: 'stub-session-0001', parent_tool_use_id: null,
    message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'stub-model',
      content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 } },
    ...overrides,
  }
}

function resultFrame(overrides = {}) {
  return {
    type: 'result', subtype: 'success', uuid: 'u-0003', session_id: 'stub-session-0001',
    duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1, result: 'done',
    total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 }, permission_denials: [],
    ...overrides,
  }
}

/** Drive one complete turn through the translator; returns all events. */
function runTurn(translator, text = 'Hello world', resultOverrides = {}) {
  const events = [...translator.userSubmitted({ text: 'hi', clientMessageId: 'u1' })]
  for (const frame of streamBurst(text)) events.push(...translator.translate(frame))
  events.push(...translator.translate(assistantFrame(text)))
  events.push(...translator.translate(resultFrame(resultOverrides)))
  return events
}

test('a full turn maps to user/attempt/deltas/message/end with a contiguous identity map', () => {
  const translator = createCodebuddyTranslator({ cwd: 'D:/fixture/project', now: NOW })
  translator.translate(initFrame())
  const events = runTurn(translator, 'Hello world')
  const audit = createIdentityAudit()
  audit.check(events) // whole-stream invariants must hold

  assert.deepEqual(events.map(e => e.type), [
    'user.message', 'turn.start',
    'step.start', 'assistant.attempt.start',
    'assistant.delta', 'assistant.delta',
    'assistant.attempt.end', 'step.end',
    'assistant.message',
    'turn.end',
  ])
  const deltas = events.filter(e => e.type === 'assistant.delta')
  assert.equal(deltas[0].attemptId, 'a1')
  assert.equal(deltas[0].index, 0)
  assert.equal(deltas[1].index, 1)
  assert.deepEqual(deltas.map(e => e.delta.text), ['Hel', 'lo world'])
  const message = events.find(e => e.type === 'assistant.message')
  assert.equal(message.attemptId, 'a1')
  assert.equal(message.turn, 1)
  assert.equal(message.step, 1)
  assert.equal(message.canonical, true)
  assert.deepEqual(message.blocks, [{ kind: 'text', text: 'Hello world' }])
  assert.deepEqual(message.usage, { input: 10, output: 5 })
  const end = events.find(e => e.type === 'turn.end')
  assert.deepEqual(end.reason, { kind: 'completed' })
  // result.usage is session-cumulative; turn 1 delta equals the whole.
  assert.deepEqual(end.usage, { input: 10, output: 5 })
  assert.deepEqual(end.cost, { amount: 0.01, currency: 'USD', source: 'backend' })
})

test('a second turn continues seq/turn monotonically and resets step', () => {
  const translator = createCodebuddyTranslator({ cwd: 'D:/fixture/project', now: NOW })
  const audit = createIdentityAudit()
  const first = runTurn(translator, 'first')
  audit.check(first) // audit state carries turn 1 forward
  const events = runTurn(translator, 'second', { usage: { input_tokens: 25, output_tokens: 9 } })
  audit.check(events) // whole-stream invariants across both turns
  const seqs = events.filter(e => typeof e.seq === 'number').map(e => e.seq)
  assert.deepEqual(seqs, [3, 4]) // user.message and assistant.message continue after turn 1's seq 2
  const start = events.find(e => e.type === 'turn.start')
  assert.equal(start.turn, 2)
  const message = events.find(e => e.type === 'assistant.message')
  assert.equal(message.step, 1) // step resets per turn
  const end = events.find(e => e.type === 'turn.end')
  // per-turn delta: 25-10 input, 9-5 output
  assert.deepEqual(end.usage, { input: 15, output: 4 })
})

test('thinking deltas map to reasoning deltas; thinking blocks land in the message', () => {
  const translator = createCodebuddyTranslator({ cwd: 'D:/fixture/project', now: NOW })
  translator.translate(initFrame())
  translator.userSubmitted({ text: 'hi', clientMessageId: 'u1' })
  translator.translate({
    type: 'stream_event', uuid: 'se-1', session_id: 's', parent_tool_use_id: null,
    event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } } },
  )
  const deltaEvents = translator.translate({
    type: 'stream_event', uuid: 'se-2', session_id: 's', parent_tool_use_id: null,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'pondering' } } },
  )
  assert.deepEqual(deltaEvents.map(e => e.delta), [{ kind: 'reasoning', text: 'pondering' }])
  const message = translator.translate(assistantFrame('answer', {
    message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'stub-model',
      content: [{ type: 'thinking', signature: 'sig', thinking: 'pondering' }, { type: 'text', text: 'answer' }],
      stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
  ))
  const row = message.find(e => e.type === 'assistant.message')
  assert.deepEqual(row.blocks, [
    { kind: 'reasoning', text: 'pondering' },
    { kind: 'text', text: 'answer' },
  ])
})

test('tool_use blocks become tool.call events and tool_result user frames become tool.result', () => {
  const translator = createCodebuddyTranslator({ cwd: 'D:/fixture/project', now: NOW })
  translator.translate(initFrame())
  const events = []
  events.push(...translator.userSubmitted({ text: 'run it', clientMessageId: 'u1' }))
  events.push(...translator.translate({
    type: 'assistant', uuid: 'u-0002', session_id: 's', parent_tool_use_id: null,
    message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'stub-model',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo hi' } }],
      stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } } },
  ))
  const call = events.find(e => e.type === 'tool.call')
  assert.deepEqual(call, {
    type: 'tool.call', seq: 2, anchor: 'u-0002', turn: 1, step: 1, callId: 'toolu_1',
    name: 'Bash', argsJson: '{"command":"echo hi"}', time: NOW(),
    presentation: { card: 'terminal', title: 'echo hi', cwd: 'D:/fixture/project' },
  })
  // The message row itself carries no tool block (tools are their own family).
  const row = events.find(e => e.type === 'assistant.message')
  assert.deepEqual(row.blocks, [])
  // The CLI delivers the tool result as a user frame with parent_tool_use_id.
  events.push(...translator.translate({
    type: 'user', uuid: 'u-0003', session_id: 's', parent_tool_use_id: 'toolu_1',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'hi' }] } },
  ))
  const result = events.find(e => e.type === 'tool.result')
  assert.equal(result.callId, 'toolu_1')
  assert.equal(result.isError, false)
  assert.equal(result.text, 'hi')
  assert.equal(result.turn, 1)
  assert.equal(result.step, 1)
  createIdentityAudit().check(events)
})

test('a failed tool result carries errorText; error subtypes end the turn with kind:error', () => {
  const translator = createCodebuddyTranslator({ cwd: 'D:/fixture/project', now: NOW })
  translator.translate(initFrame())
  const events = []
  events.push(...translator.userSubmitted({ text: 'run', clientMessageId: 'u1' }))
  events.push(...translator.translate({
    type: 'assistant', uuid: 'u-0002', session_id: 's', parent_tool_use_id: null,
    message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'stub-model',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }],
      stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
  ))
  events.push(...translator.translate({
    type: 'user', uuid: 'u-0003', session_id: 's', parent_tool_use_id: 'toolu_1',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'boom', is_error: true }] } },
  ))
  const result = events.find(e => e.type === 'tool.result')
  assert.equal(result.isError, true)
  assert.equal(result.errorText, 'boom')
  events.push(...translator.translate(resultFrame({
    subtype: 'error_during_execution', is_error: true, errors: ['CLI exploded'],
    usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0,
  })))
  const end = events.find(e => e.type === 'turn.end')
  assert.deepEqual(end.reason, { kind: 'error', message: 'CLI exploded' })
  createIdentityAudit().check(events)
})

test('bare error payloads fall back to the bilingual dict, never a hardcoded literal', () => {
  // Empty error text on a failed tool_result → the dict's tool-failed marker
  // in the accessor's language (the session binds it to the live locale).
  const en = createCodebuddyTranslator({ cwd: 'D:/fixture/project', now: NOW, text: enText })
  en.translate(initFrame())
  const events = [...en.userSubmitted({ text: 'run', clientMessageId: 'u1' })]
  events.push(...en.translate({
    type: 'assistant', uuid: 'u-0002', session_id: 's', parent_tool_use_id: null,
    message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'stub-model',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }],
      stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
  }))
  events.push(...en.translate({
    type: 'user', uuid: 'u-0003', session_id: 's', parent_tool_use_id: 'toolu_1',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '', is_error: true }] },
  }))
  assert.equal(events.find(e => e.type === 'tool.result').errorText, 'Tool failed')

  // A result subtype the error family without an errors[] payload and without
  // even a subtype string → the dict's turn-error marker.
  const zh = createCodebuddyTranslator({ cwd: 'D:/fixture/project', now: NOW })
  zh.translate(initFrame())
  zh.userSubmitted({ text: 'run', clientMessageId: 'u1' })
  const zhEvents = zh.translate({ type: 'result', is_error: true })
  assert.deepEqual(zhEvents.find(e => e.type === 'turn.end').reason, { kind: 'error', message: '执行出错' })
  const enEvents = en.translate({ type: 'result', is_error: true })
  assert.deepEqual(enEvents.find(e => e.type === 'turn.end').reason, { kind: 'error', message: 'An error occurred' })
  createIdentityAudit().check(events)
})

test('an interrupted result (success subtype + terminal_reason) ends the turn interrupted', () => {
  const translator = createCodebuddyTranslator({ cwd: 'D:/fixture/project', now: NOW })
  translator.translate(initFrame())
  const events = [...translator.userSubmitted({ text: 'hi', clientMessageId: 'u1' })]
  events.push(...translator.translate(resultFrame({ terminal_reason: 'interrupt', result: '' })))
  const end = events.find(e => e.type === 'turn.end')
  assert.deepEqual(end.reason, { kind: 'interrupted' })
  createIdentityAudit().check(events)
})

test('terminal_reason variants: end_turn/absent complete, unknown values stay visible as other', () => {
  const translator = createCodebuddyTranslator({ cwd: 'D:/fixture/project', now: NOW })
  translator.translate(initFrame())
  // Natural completion states the CLI's EXIT_REASONS value for a finished turn.
  let events = [...translator.userSubmitted({ text: 'hi', clientMessageId: 'u1' })]
  events.push(...translator.translate(resultFrame({ terminal_reason: 'end_turn' })))
  assert.deepEqual(events.find(e => e.type === 'turn.end').reason, { kind: 'completed' })

  // An older CLI may omit the runtime-only field entirely — still a completion.
  events = [...translator.userSubmitted({ text: 'again', clientMessageId: 'u2' })]
  events.push(...translator.translate(resultFrame()))
  assert.deepEqual(events.find(e => e.type === 'turn.end').reason, { kind: 'completed' })

  // A reason outside the mapped set (e.g. user_exit from the CLI's
  // EXIT_REASONS tuple) must not masquerade as 'completed' — surface it.
  events = [...translator.userSubmitted({ text: 'third', clientMessageId: 'u3' })]
  events.push(...translator.translate(resultFrame({ terminal_reason: 'user_exit' })))
  assert.deepEqual(events.find(e => e.type === 'turn.end').reason, { kind: 'other', label: 'user_exit' })
})

test('terminal_reason hook_blocked maps to a blocked turn end — the host vocabulary has no hooks event family', () => {
  const translator = createCodebuddyTranslator({ cwd: 'D:/fixture/project', now: NOW })
  translator.translate(initFrame())
  const all = []
  // The hook-blocked shape: a success result (interrupts and blocks both ride
  // the success subtype — codebuddy-sdk notes §2.2) carrying the runtime-only
  // terminal_reason 'hook_blocked'.
  let events = [...translator.userSubmitted({ text: 'hi', clientMessageId: 'u1' })]
  events.push(...translator.translate(resultFrame({ terminal_reason: 'hook_blocked', errors: ['Stop hook: push denied'] })))
  assert.deepEqual(events.find(e => e.type === 'turn.end').reason, { kind: 'blocked', detail: 'Stop hook: push denied' })
  all.push(...events)
  // No CLI error strings → bare blocked, detail stays absent (no invention).
  events = [...translator.userSubmitted({ text: 'again', clientMessageId: 'u2' })]
  events.push(...translator.translate(resultFrame({ terminal_reason: 'hook_blocked' })))
  assert.deepEqual(events.find(e => e.type === 'turn.end').reason, { kind: 'blocked' })
  all.push(...events)
  // The generic unknown-reason escape stays for values outside the mapped set.
  events = [...translator.userSubmitted({ text: 'third', clientMessageId: 'u3' })]
  events.push(...translator.translate(resultFrame({ terminal_reason: 'user_exit' })))
  assert.deepEqual(events.find(e => e.type === 'turn.end').reason, { kind: 'other', label: 'user_exit' })
  all.push(...events)
  createIdentityAudit().check(all)
})

test('streaming tool-args deltas carry the partial JSON attributed to the callId', () => {
  const translator = createCodebuddyTranslator({ cwd: 'D:/fixture/project', now: NOW })
  translator.translate(initFrame())
  translator.userSubmitted({ text: 'go', clientMessageId: 'u1' })
  translator.translate({ type: 'stream_event', uuid: 'se-1', session_id: 's', parent_tool_use_id: null,
    event: { type: 'message_start', message: { id: 'msg_1', model: 'stub-model' } } })
  translator.translate({ type: 'stream_event', uuid: 'se-2', session_id: 's', parent_tool_use_id: null,
    event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_9', name: 'Write' } } })
  const deltas = translator.translate({ type: 'stream_event', uuid: 'se-3', session_id: 's', parent_tool_use_id: null,
    event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path"' } } })
  assert.deepEqual(deltas.map(e => e.delta), [{ kind: 'tool-args', callId: 'toolu_9', name: 'Write', partialJson: '{"path"' }])
})

test('frames of a second step (tool loop) bump step monotonically', () => {
  const translator = createCodebuddyTranslator({ cwd: 'D:/fixture/project', now: NOW })
  translator.translate(initFrame())
  const events = []
  events.push(...translator.userSubmitted({ text: 'go', clientMessageId: 'u1' }))
  events.push(...translator.translate(assistantFrame('using tool', {
    uuid: 'u-0002',
    message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'stub-model',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }],
      stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
  )))
  events.push(...translator.translate({
    type: 'user', uuid: 'u-0003', session_id: 's', parent_tool_use_id: 'toolu_1',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } },
  ))
  events.push(...streamBurst('final answer'))
  events.push(...translator.translate(assistantFrame('final answer', { uuid: 'u-0004' })))
  events.push(...translator.translate(resultFrame()))
  const steps = events.filter(e => e.type === 'assistant.message').map(e => e.step)
  assert.deepEqual(steps, [1, 2])
  const calls = events.filter(e => e.type === 'tool.call').map(e => e.step)
  assert.deepEqual(calls, [1]) // the call belongs to the step that issued it
  createIdentityAudit().check(events)
})

test('tool_progress frames map to tool.progress with millisecond elapsed time', () => {
  const translator = createCodebuddyTranslator({ cwd: 'D:/fixture/project', now: NOW })
  translator.translate(initFrame())
  const events = [...translator.userSubmitted({ text: 'go', clientMessageId: 'u1' })]
  events.push(...translator.translate({
    type: 'assistant', uuid: 'u-0002', session_id: 's', parent_tool_use_id: null,
    message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'stub-model',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }],
      stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
  ))
  const progress = translator.translate({
    type: 'tool_progress', uuid: 'u-0003', session_id: 's', parent_tool_use_id: null,
    tool_use_id: 'toolu_1', tool_name: 'Bash', elapsed_time_seconds: 1.5,
  })
  assert.deepEqual(progress, [{ type: 'tool.progress', callId: 'toolu_1', elapsedMs: 1500 }])
  // progress for an unknown call is ignored (no fabricated events)
  const unknown = translator.translate({
    type: 'tool_progress', uuid: 'u-0004', session_id: 's', parent_tool_use_id: null,
    tool_use_id: 'toolu_ghost', tool_name: 'Bash', elapsed_time_seconds: 2,
  })
  assert.deepEqual(unknown, [])
})

// ── T6 slice: usage accounting (usage_update vs result.usage) ────────────────
//
// Credits doc (codebuddy-sdk notes §8): every model call / generation tool
// emits `system/usage_update` with the payload in `_meta['codebuddy.ai/turnUsage']`
// (kind 'stage' mid-turn, kind 'snapshot' before the result); the result's own
// `_meta['codebuddy.ai/turnUsage']` is IDENTICAL to the snapshot — so the two
// families must never be mapped twice. `result.usage` is SESSION-CUMULATIVE
// and maps to the per-turn delta on turn.end. The host books tokens from
// assistant.message.usage (projection.ts bookUsage) — usage_update tokens ride
// the custom event data and never become a second bookable copy.

/** A usage_update stage frame the CLI emits after one model call. */
function usageUpdateStage(stageId = 'model:msg_1', credits = 2) {
  return {
    type: 'system', subtype: 'usage_update', uuid: 'u-uu1', session_id: 'stub-session-0001',
    _meta: { 'codebuddy.ai/turnUsage': { version: 1, scope: 'turn', kind: 'stage', requestId: 'req-1',
      stage: { id: stageId, credits, delta: { credits } } } },
  }
}

/** The turn-end snapshot usage_update (totals + per-stage list, no delta). */
function usageUpdateSnapshot() {
  return {
    type: 'system', subtype: 'usage_update', uuid: 'u-uu2', session_id: 'stub-session-0001',
    _meta: { 'codebuddy.ai/turnUsage': { version: 1, scope: 'turn', kind: 'snapshot', requestId: 'req-1',
      total: { usage: { input_tokens: 10, output_tokens: 5 }, credits: 3, creditStatus: 'known' },
      stages: [{ id: 'model:msg_1', credits: 2 }, { id: 'model:msg_2', credits: 1 }] } },
  }
}

/** A result whose `_meta` duplicates the snapshot payload (credits doc: 完全相同). */
function resultWithTurnUsageMeta(overrides = {}) {
  return resultFrame({
    _meta: { 'codebuddy.ai/turnUsage': { version: 1, scope: 'turn', kind: 'snapshot', requestId: 'req-1',
      total: { usage: { input_tokens: 10, output_tokens: 5 }, credits: 3, creditStatus: 'known' },
      stages: [{ id: 'model:msg_1', credits: 2 }, { id: 'model:msg_2', credits: 1 }] } },
    ...overrides,
  })
}

test('usage_update stage maps to a codebuddy.turn-usage custom event (defensive _meta parse)', () => {
  const translator = createCodebuddyTranslator({ cwd: 'D:/fixture/project', now: NOW })
  const events = translator.translate(usageUpdateStage())
  assert.equal(events.length, 1)
  assert.deepEqual(events[0], {
    type: 'custom', nativeType: 'codebuddy.turn-usage',
    data: { kind: 'stage', requestId: 'req-1', stage: { id: 'model:msg_1', credits: 2, delta: { credits: 2 } } },
  })
})

test('usage_update snapshot maps token totals and the stage count, never a bookable usage event', () => {
  const translator = createCodebuddyTranslator({ cwd: 'D:/fixture/project', now: NOW })
  const events = translator.translate(usageUpdateSnapshot())
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'custom')
  assert.equal(events[0].nativeType, 'codebuddy.turn-usage')
  assert.deepEqual(events[0].data, {
    kind: 'snapshot', requestId: 'req-1',
    total: { usage: { input: 10, output: 5 }, credits: 3, creditStatus: 'known' },
    stageCount: 2,
  })
})

test('malformed usage_update payloads are ignored, never fatal', () => {
  const translator = createCodebuddyTranslator({ cwd: 'D:/fixture/project', now: NOW })
  assert.deepEqual(translator.translate({ type: 'system', subtype: 'usage_update', uuid: 'u', session_id: 's' }), [])
  assert.deepEqual(translator.translate({ type: 'system', subtype: 'usage_update', uuid: 'u', session_id: 's', _meta: {} }), [])
  assert.deepEqual(translator.translate({ type: 'system', subtype: 'usage_update', uuid: 'u', session_id: 's', _meta: { 'codebuddy.ai/turnUsage': 'junk' } }), [])
  assert.deepEqual(translator.translate({ type: 'system', subtype: 'usage_update', uuid: 'u', session_id: 's', _meta: { 'codebuddy.ai/turnUsage': { kind: 'galaxy' } } }), [])
  // and the translator still works afterwards
  assert.equal(translator.translate(usageUpdateStage()).length, 1)
})

test('a whole turn: usage_update emits NO bookable usage events — tokens stay on assistant.message', () => {
  const translator = createCodebuddyTranslator({ cwd: 'D:/fixture/project', now: NOW })
  translator.translate(initFrame())
  const events = []
  events.push(...translator.userSubmitted({ text: 'hi', clientMessageId: 'u1' }))
  events.push(...translator.translate(usageUpdateStage('model:msg_1', 1)))
  events.push(...translator.translate(streamBurst('Hello')))
  events.push(...translator.translate(assistantFrame('Hello')))
  events.push(...translator.translate(usageUpdateStage('model:msg_1', 2)))
  events.push(...translator.translate(usageUpdateSnapshot()))
  events.push(...translator.translate(resultWithTurnUsageMeta()))
  // The host books tokens from assistant.message.usage; a `usage` event here
  // would double-book every token (projection.ts bookUsage reads both).
  assert.ok(!events.some(e => e.type === 'usage'), 'no bookable usage event may derive from usage_update')
  const message = events.find(e => e.type === 'assistant.message')
  assert.deepEqual(message.usage, { input: 10, output: 5 })
})

test('anti-double-add: the snapshot usage_update and the identical result _meta yield exactly ONE credits event', () => {
  const translator = createCodebuddyTranslator({ cwd: 'D:/fixture/project', now: NOW })
  translator.translate(initFrame())
  const events = []
  events.push(...translator.userSubmitted({ text: 'hi', clientMessageId: 'u1' }))
  events.push(...translator.translate(usageUpdateStage('model:msg_1', 2)))
  events.push(...translator.translate(usageUpdateStage('model:msg_2', 1)))
  events.push(...translator.translate(assistantFrame('done')))
  events.push(...translator.translate(usageUpdateSnapshot()))
  // The result repeats the snapshot payload verbatim (credits doc) — the
  // translator must not map it again.
  events.push(...translator.translate(resultWithTurnUsageMeta()))
  const credits = events.filter(e => e.type === 'custom' && e.nativeType === 'codebuddy.turn-usage')
  assert.equal(credits.filter(e => e.data.kind === 'snapshot').length, 1, 'one snapshot event, not two')
  assert.equal(credits.filter(e => e.data.kind === 'stage').length, 2)
})

test('anti-double-add: turn.end.usage deltas sum to the final session-cumulative, never re-add it', () => {
  const translator = createCodebuddyTranslator({ cwd: 'D:/fixture/project', now: NOW })
  translator.translate(initFrame())
  const endUsages = []
  // Three turns whose result.usage is the SESSION-CUMULATIVE counter: 10→20→30.
  for (let cumulative = 10; cumulative <= 30; cumulative += 10) {
    const events = [
      ...translator.userSubmitted({ text: 'hi', clientMessageId: `u${cumulative}` }),
      ...translator.translate(assistantFrame('reply')),
      ...translator.translate(resultFrame({ usage: { input_tokens: cumulative, output_tokens: cumulative / 2 } })),
    ]
    endUsages.push(events.find(e => e.type === 'turn.end').usage)
  }
  // Per-turn deltas, NOT the cumulative value repeated three times.
  assert.deepEqual(endUsages, [{ input: 10, output: 5 }, { input: 10, output: 5 }, { input: 10, output: 5 }])
  // The deltas sum exactly to the final cumulative — nothing double-added.
  const sum = endUsages.reduce((acc, u) => ({ input: acc.input + u.input, output: acc.output + u.output }), { input: 0, output: 0 })
  assert.deepEqual(sum, { input: 30, output: 15 })
})

// ── slice 3: tool cards — presentation is shape-driven, never name-keyed ─────

test('tool.call carries a presentation card picked from the input shape, whatever the tool name', () => {
  const translator = createCodebuddyTranslator({ cwd: 'D:/fixture/project', now: NOW })
  translator.translate(initFrame())
  const events = []
  events.push(...translator.userSubmitted({ text: 'go', clientMessageId: 'u1' }))
  // Three tool names the bundle has no table for: the card must come from the
  // input shape alone (the ticket's "不按工具名特判").
  events.push(...translator.translate({
    type: 'assistant', uuid: 'u-0002', session_id: 's', parent_tool_use_id: null,
    message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'stub-model',
      content: [
        { type: 'tool_use', id: 'toolu_1', name: 'CustomRunner', input: { command: 'echo hi', description: 'greet' } },
        { type: 'tool_use', id: 'toolu_2', name: 'ApplyPatch', input: { file_path: 'src/a.js', old_string: 'a', new_string: 'b' } },
        { type: 'tool_use', id: 'toolu_3', name: 'Weird', input: { foo: 1 } },
      ],
      stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
  ))
  const calls = events.filter(e => e.type === 'tool.call')
  assert.equal(calls.length, 3)
  // A command-shaped input renders the terminal card — on an unknown name.
  assert.deepEqual(calls[0].presentation, {
    card: 'terminal', title: 'echo hi', description: 'greet', cwd: 'D:/fixture/project',
  })
  // An old/new string pair renders the diff card.
  assert.deepEqual(calls[1].presentation, {
    card: 'diff', title: 'src/a.js', diffs: [{ path: 'src/a.js', oldText: 'a', newText: 'b' }],
  })
  // A shape the picker does not recognise stays presentation-less: the host
  // renders the neutral generic card from the args.
  assert.equal(calls[2].presentation, undefined)
  createIdentityAudit().check(events)
})

test('tool.result updates the card with a bounded run-output tail', () => {
  const translator = createCodebuddyTranslator({ cwd: 'D:/fixture/project', now: NOW })
  translator.translate(initFrame())
  const events = []
  events.push(...translator.userSubmitted({ text: 'go', clientMessageId: 'u1' }))
  events.push(...translator.translate({
    type: 'assistant', uuid: 'u-0002', session_id: 's', parent_tool_use_id: null,
    message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'stub-model',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'CustomRunner', input: { command: 'seq 1 250' } }],
      stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
  ))
  const lines = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`)
  events.push(...translator.translate({
    type: 'user', uuid: 'u-0003', session_id: 's', parent_tool_use_id: 'toolu_1',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: lines.join('\n') }] } },
  ))
  const result = events.find(e => e.type === 'tool.result')
  // The persistent record keeps the full text; only the card output is a tail.
  assert.ok(result.text.includes('line 1\n'))
  const card = result.presentation
  assert.equal(card.card, 'terminal')
  const cardLines = card.output.split('\n')
  assert.equal(cardLines.length, 201, 'dropped marker + the last 200 lines')
  assert.match(cardLines[0], /50/)
  assert.equal(cardLines[1], 'line 51')
  assert.equal(cardLines.at(-1), 'line 250')
  // A failed result keeps the plain-text card (no structured presentation).
  events.push(...translator.translate({
    type: 'assistant', uuid: 'u-0004', session_id: 's', parent_tool_use_id: null,
    message: { id: 'msg_2', type: 'message', role: 'assistant', model: 'stub-model',
      content: [{ type: 'tool_use', id: 'toolu_2', name: 'CustomRunner', input: { command: 'boom' } }],
      stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
  ))
  events.push(...translator.translate({
    type: 'user', uuid: 'u-0005', session_id: 's', parent_tool_use_id: 'toolu_2',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'boom', is_error: true }] } },
  ))
  const failed = events.filter(e => e.type === 'tool.result').at(-1)
  assert.equal(failed.presentation, undefined)
  createIdentityAudit().check(events)
})
