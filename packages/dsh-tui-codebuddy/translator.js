/**
 * CodeBuddy protocol translator — the pure state machine that turns
 * `@tencent-ai/agent-sdk` messages (the stream-json protocol the CLI speaks)
 * into the bundle's self-declared AgentEvent vocabulary.
 *
 * Fixture approach (host-surface notes §7B): the event shapes are declared by
 * THIS bundle — nothing is imported from dsh-TUI (neither src/ nor the host's
 * type surface). The shapes below mirror the host's agent-domain contract as
 * documented in the shared host-surface notes (§1 AgentEvent full table), and
 * the host's assembly-chain behavior checks are the safety net for the fit.
 *
 * Live and replay share the same mapping (docs/decisions.md MVP item 2):
 * every event in this file is derived from protocol frames only. The one
 * exception is `userSubmitted()` — the user's own message/turn.start pair at
 * submit time, which has no protocol frame of its own (the CLI does not echo
 * stdin writes back unless `--replay-user-messages` is enabled).
 *
 * Unknown protocol messages are ignored (never fatal): the SDK's Message union
 * has known blind spots (system/usage_update has no .d.ts type; `type:'image'`
 * passes isMessage but is not in the union), and a newer CLI may always add
 * frames. Anything this translator does not map returns [].
 */

import { presentToolCall, presentToolResult } from './presentation.js'
import { codebuddyText } from './text.js'

const RESULT_ERROR_SUBTYPES = new Set(['error_during_execution', 'error_max_turns', 'error_max_budget_usd'])

/**
 * Identity-map audit: the invariant checker for the seq/turn/step/attemptId/
 * callId monotonic mapping (ticket T2 acceptance). One instance per session;
 * `check(events)` throws on the first violation, so a mapping bug fails
 * loudly at the seam instead of silently corrupting the channel.
 *
 * Rules:
 * - seq: assigned only to persistent-record events (user.message,
 *   assistant.message, tool.call, tool.result) and always contiguous 1,2,3…
 *   so the channel can order/dedup on it; streaming deltas are ephemeral and
 *   carry no seq (the host's AgentEvent table marks `assistant.delta.seq?`
 *   optional).
 * - turn: strictly one per turn.start, ever increasing; every other event's
 *   turn never exceeds the open turn.
 * - step: starts at 1 per turn; each step.start must follow the previous one.
 * - attemptId: unique per session; attempt.end closes a started attempt.
 * - callId: unique per tool.call; a tool.result must pair a prior tool.call.
 */
export function createIdentityAudit() {
  let lastSeq = 0
  let maxTurn = 0
  let openStep = 0
  const attempts = new Set()
  const calls = new Set()
  return {
    check(events) {
      for (const event of events) {
        if (typeof event.seq === 'number') {
          if (lastSeq === 0) {
            fail(event, 'first seq-carrying event must be seq 1', event.seq === 1)
          } else {
            fail(event, `seq must be contiguous: ${lastSeq} → ${event.seq}`, event.seq === lastSeq + 1)
          }
          lastSeq = event.seq
        }
        if (typeof event.turn === 'number') {
          if (event.type === 'turn.start') {
            fail(event, `turn must increase: seen ${maxTurn}, start ${event.turn}`, event.turn === maxTurn + 1)
            maxTurn = event.turn
            openStep = 0
          } else if (event.type === 'user.message' && event.turn === maxTurn + 1) {
            // user.message precedes its own turn.start in the same batch (the
            // submit pair) — it pre-declares the turn about to open.
          } else {
            fail(event, `event turn ${event.turn} beyond open turn ${maxTurn}`, event.turn <= maxTurn)
          }
        }
        if (typeof event.step === 'number' && event.type === 'step.start') {
          fail(event, `step.start must follow step ${openStep}, got ${event.step}`, event.step === openStep + 1)
          openStep = event.step
        }
        if (event.type === 'assistant.attempt.start') {
          fail(event, `attemptId must be unique: ${event.attemptId}`, !attempts.has(event.attemptId))
          attempts.add(event.attemptId)
        }
        if (event.type === 'assistant.attempt.end') {
          fail(event, `attempt.end for unknown attempt ${event.attemptId}`, attempts.has(event.attemptId))
        }
        if (event.type === 'tool.call') {
          fail(event, `callId must be unique: ${event.callId}`, !calls.has(event.callId))
          calls.add(event.callId)
        }
        if (event.type === 'tool.result') {
          fail(event, `tool.result for unknown callId ${event.callId}`, calls.has(event.callId))
        }
      }
    },
  }
}

function fail(event, message, ok) {
  if (!ok) {
    throw new AssertionError(`${message} (at ${JSON.stringify(event)})`)
  }
}

class AssertionError extends Error {
  constructor(message) {
    super(`dsh-tui-codebuddy identity map: ${message}`)
    this.name = 'AssertionError'
  }
}

/**
 * Create a translator for one session.
 *
 * @param {object} options
 *   cwd: session working directory (fallback when init omits it)
 *   now: clock injection returning epoch ms
 *   debug: sink for ignored-frame diagnostics (opt-in host debug, never user-visible)
 *   text: bilingual dict accessor `(key, params) => string`, pre-bound to the
 *     live host locale by the session (direct translator use defaults to zh)
 *   replay: true for a resumed session — until `settleReplay()`, canonical
 *     protocol frames arriving OUTSIDE a turn are the CLI's persisted-history
 *     replay (ticket T5): user frames re-open their historical turn and every
 *     family re-anchors to the CLI's own uuid. Live submits are impossible in
 *     this mode (the session defers them until the settle), so the seq/turn
 *     counters flow straight from the replay into the live stream.
 */
export function createCodebuddyTranslator({
  cwd,
  now = Date.now,
  debug = () => {},
  text = (key, params) => codebuddyText(key, 'zh', params),
  replay = false,
} = {}) {
  const audit = createIdentityAudit()

  // ── identity-map state ──────────────────────────────────────────────────
  let seq = 0 // last assigned seq
  let turn = 0 // last opened turn
  let step = 0 // last step opened in the current turn
  let attemptCounter = 0
  let openAttempt = null // {id, turn, step, deltas, firstTokenTime}
  let activeTurn = null // {number} while a turn is running
  const blockCalls = new Map() // stream content_block index → {callId, name, partialJson}
  const callLocation = new Map() // callId → {turn, step} recorded at tool.call
  const callInputs = new Map() // callId → the model's input record, for the result card
  let readyEmitted = false
  let cumulativeUsage = null // session-cumulative tokens from the last result
  let replayMode = replay === true // resume replay phase; ends only at settleReplay()

  const nextSeq = () => ++seq

  /** Deliver events through the invariant audit; a violation is loud. */
  function seal(events) {
    audit.check(events)
    return events
  }

  // ── submit side (no protocol frame exists for the user's own message) ────
  function userSubmitted(input, time = now()) {
    if (activeTurn !== null) return seal([]) // caller (session) queues instead
    const userMessageId = input.clientMessageId
    turn += 1
    step = 0
    activeTurn = { number: turn }
    return seal([
      {
        type: 'user.message',
        seq: nextSeq(),
        // anchor: the native resume/rewind anchor. The CLI does not echo our
        // stdin write back, so the channel-generated clientMessageId is the
        // stable identity we hold at submit time; CLI-assigned uuids anchor
        // assistant/tool events, and --resume replay (T5) re-anchors user
        // rows from the transcript's own uuids through this same translator.
        anchor: userMessageId,
        id: userMessageId,
        turn: activeTurn.number,
        time,
        source: 'user',
        text: input.text ?? '',
        blocks: input.blocks ?? [],
        // The attachment refs the channel handed in (T6): echoed verbatim so
        // the user row renders its chips — the facade keeps the bytes lazy.
        ...(Array.isArray(input.images) && input.images.length > 0 ? { images: input.images } : {}),
      },
      {
        type: 'turn.start',
        turn: activeTurn.number,
        origin: 'user',
        userMessageId,
        time,
      },
    ])
  }

  // ── turn abandonment (dispose / transport death — no result will come) ──
  function abandonTurn(reason, time = now()) {
    if (activeTurn === null) return seal([])
    const ended = activeTurn
    activeTurn = null
    const events = closeOpenAttempt('aborted', time)
    events.push({ type: 'turn.end', turn: ended.number, reason, time })
    return seal(events)
  }

  function closeOpenAttempt(outcome, time) {
    if (openAttempt === null) return []
    const attempt = openAttempt
    openAttempt = null
    return [
      { type: 'assistant.attempt.end', attemptId: attempt.id, outcome, turn: attempt.turn, step: attempt.step },
      { type: 'step.end', turn: attempt.turn, step: attempt.step },
    ]
  }

  /** Open the streaming attempt for the next model call — lazily: the first
   *  stream_event (or assistant message) of a step creates it. */
  function ensureAttempt(time, model) {
    if (openAttempt !== null || activeTurn === null) return null
    attemptCounter += 1
    step += 1
    openAttempt = { id: `a${attemptCounter}`, turn: activeTurn.number, step, deltas: 0, firstTokenTime: undefined }
    return [
      { type: 'step.start', turn: activeTurn.number, step },
      {
        type: 'assistant.attempt.start',
        attemptId: openAttempt.id,
        turn: activeTurn.number,
        step,
        ...(model !== undefined ? { model } : {}),
        firstTokenTime: time,
      },
    ]
  }

  function emitDelta(delta, time) {
    if (openAttempt === null) return []
    openAttempt.deltas += 1
    if (openAttempt.firstTokenTime === undefined) openAttempt.firstTokenTime = time
    return [{
      type: 'assistant.delta',
      attemptId: openAttempt.id,
      index: openAttempt.deltas - 1,
      time,
      turn: openAttempt.turn,
      step: openAttempt.step,
      delta,
    }]
  }

  // ── frame dispatch ───────────────────────────────────────────────────────
  function translate(frame, time = now()) {
    if (frame === null || typeof frame !== 'object') return seal([])
    switch (frame.type) {
      case 'system': return seal(translateSystem(frame, time))
      case 'stream_event': return seal(translateStreamEvent(frame, time))
      case 'assistant': return seal(translateAssistant(frame, time))
      case 'user': return seal(translateUserEcho(frame, time))
      case 'result': return seal(translateResult(frame, time))
      case 'tool_progress': return seal(translateToolProgress(frame, time))
      case 'topic':
      case 'ai-title': {
        const title = frame.type === 'topic' ? frame.topic : frame.aiTitle
        if (typeof title !== 'string' || title === '') return seal([])
        return seal([{ type: 'session.title', title, source: 'auto' }])
      }
      default:
        debug(`ignored protocol frame type ${JSON.stringify(frame.type)}`)
        return seal([])
    }
  }

  function translateSystem(frame, time) {
    if (frame.subtype === 'init') {
      if (readyEmitted) {
        debug('duplicate init frame ignored')
        return []
      }
      readyEmitted = true
      return [{
        type: 'session.ready',
        sessionId: str(frame.session_id) ?? '',
        cwd: str(frame.cwd) ?? cwd,
        model: str(frame.model),
        permissionMode: str(frame.permissionMode),
        backendVersion: str(frame.codebuddy_code_version),
        provider: 'codebuddy',
      }]
    }
    // usage_update (T6): the CLI's per-turn credits/tokens metering — the
    // payload lives in `_meta['codebuddy.ai/turnUsage']`, a field the SDK
    // 0.3.307 .d.ts does not even declare (type blind spot, notes §0), so the
    // parse is defensive end to end. See translateUsageUpdate for the
    // no-double-add policy against result.usage.
    if (frame.subtype === 'usage_update') return seal(translateUsageUpdate(frame))
    // status / compact_boundary / task_* …: capabilities this bundle does not
    // declare yet — ignored, never fatal (notes §2 lists them).
    debug(`ignored system/${str(frame.subtype) ?? '?'}`)
    return []
  }

  /**
   * `system/usage_update` → one `custom` event (the host's sanctioned escape
   * hatch for vocabulary-external native data). The accounting policy (T6,
   * "两套数字不得重复累加"):
   *
   * - CREDITS have no host-native slot (UsageDelta is tokens-only), so they
   *   ride `custom` events with nativeType 'codebuddy.turn-usage'. Both the
   *   mid-turn `stage` frames and the turn-end `snapshot` map through.
   * - TOKENS are NOT re-emitted as bookable `usage` events: the host ledger
   *   (projection.ts bookUsage) already books assistant.message.usage per
   *   model call, and the usage_update numbers describe those same calls — a
   *   second bookable copy would double every token. They stay visible as
   *   data on the snapshot event (`total.usage`).
   * - The result's own `_meta['codebuddy.ai/turnUsage']` is the snapshot
   *   repeated verbatim (credits doc), so `result` frames never map it —
   *   exactly one credits snapshot per turn.
   * - The aggregation rule is the CLI's own (overwrite by
   *   (session_id, requestId, stage.id)); the translator never sums
   *   stage/delta/total/snapshot itself.
   */
  function translateUsageUpdate(frame) {
    const meta = frame._meta
    const raw = meta !== null && typeof meta === 'object' ? meta['codebuddy.ai/turnUsage'] : undefined
    if (raw === null || typeof raw !== 'object') {
      debug('usage_update without a turnUsage payload ignored')
      return []
    }
    const kind = raw.kind === 'stage' || raw.kind === 'snapshot' ? raw.kind : undefined
    if (kind === undefined) {
      debug(`usage_update kind ${JSON.stringify(raw.kind)} ignored`)
      return []
    }
    const data = { kind }
    if (typeof raw.requestId === 'string' && raw.requestId !== '') data.requestId = raw.requestId
    if (kind === 'stage') {
      const stage = raw.stage
      if (stage !== null && typeof stage === 'object') {
        const stageOut = {}
        if (typeof stage.id === 'string') stageOut.id = stage.id
        if (typeof stage.credits === 'number') stageOut.credits = stage.credits
        if (stage.delta !== null && typeof stage.delta === 'object') {
          const delta = {}
          if (typeof stage.delta.credits === 'number') delta.credits = stage.delta.credits
          const deltaUsage = usageDelta(stage.delta.usage)
          if (deltaUsage !== undefined) delta.usage = deltaUsage
          if (Object.keys(delta).length > 0) stageOut.delta = delta
        }
        if (Object.keys(stageOut).length > 0) data.stage = stageOut
      }
    } else {
      const total = raw.total
      if (total !== null && typeof total === 'object') {
        const totalOut = {}
        const totalUsage = usageDelta(total.usage)
        if (totalUsage !== undefined) totalOut.usage = totalUsage
        if (typeof total.credits === 'number') totalOut.credits = total.credits
        if (typeof total.creditStatus === 'string') totalOut.creditStatus = total.creditStatus
        if (Object.keys(totalOut).length > 0) data.total = totalOut
      }
      // The full per-stage list is CLI-internal bookkeeping; the count keeps
      // the event bounded without inventing a summary the CLI did not send.
      if (Array.isArray(raw.stages)) data.stageCount = raw.stages.length
    }
    return [{ type: 'custom', nativeType: 'codebuddy.turn-usage', data }]
  }

  function translateStreamEvent(frame, time) {
    const event = frame.event
    if (event === null || typeof event !== 'object') return []
    if (activeTurn === null) {
      debug('stream_event outside a turn ignored')
      return []
    }
    switch (event.type) {
      case 'message_start':
        return ensureAttempt(time, str(event.message?.model)) ?? []
      case 'content_block_start': {
        const events = ensureAttempt(time) ?? []
        if (event.content_block?.type === 'tool_use' && openAttempt !== null) {
          // The canonical tool.call comes with the assistant message; the
          // stream only reveals call id/name first — remember the block so
          // the input_json_delta stream can attribute its partial args.
          blockCalls.set(event.index, {
            callId: str(event.content_block.id) ?? '',
            name: str(event.content_block.name) ?? '',
            partialJson: '',
          })
        }
        return events
      }
      case 'content_block_delta': {
        const opened = ensureAttempt(time)
        const events = opened ?? []
        const delta = event.delta
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          events.push(...emitDelta({ kind: 'text', text: delta.text }, time))
        } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          events.push(...emitDelta({ kind: 'reasoning', text: delta.thinking }, time))
        } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const call = blockCalls.get(event.index)
          if (call !== undefined) {
            call.partialJson += delta.partial_json
            events.push(...emitDelta({ kind: 'tool-args', callId: call.callId, ...(call.name !== '' ? { name: call.name } : {}), partialJson: delta.partial_json }, time))
          } else {
            events.push(...emitDelta({ kind: 'other' }, time))
          }
        } else {
          // signature_delta and friends carry no user-visible text.
          events.push(...emitDelta({ kind: 'other' }, time))
        }
        return events
      }
      default:
        return [] // content_block_stop / message_delta / message_stop: bookkeeping only
    }
  }

  function translateAssistant(frame, time) {
    const message = frame.message
    if (message === null || typeof message !== 'object') return []
    if (activeTurn === null) {
      debug('assistant message outside a turn ignored')
      return []
    }
    const events = []
    // A step with no prior stream_event (CLI didn't stream) still gets its
    // attempt opened and immediately committed.
    if (openAttempt === null) {
      events.push(...ensureAttempt(time, str(message.model)) ?? [])
    }
    const attemptId = openAttempt.id
    const attemptTurn = openAttempt.turn
    const attemptStep = openAttempt.step
    events.push(...closeOpenAttempt('committed', time))

    // Text/thinking blocks go into the canonical transcript row; tool_use
    // blocks become tool.call events of the tool family instead — tool cards
    // are their own vocabulary, not message blocks (notes §1).
    const blocks = []
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        blocks.push({ kind: 'text', text: block.text })
      } else if (block?.type === 'thinking' && typeof block.thinking === 'string') {
        blocks.push({ kind: 'reasoning', text: block.thinking })
      } else if (block?.type === 'tool_use') {
        const callId = str(block.id) ?? ''
        const argsJson = JSON.stringify(block.input ?? {})
        const name = str(block.name) ?? ''
        callLocation.set(callId, { turn: attemptTurn, step: attemptStep })
        if (block.input !== null && typeof block.input === 'object') callInputs.set(callId, block.input)
        const presentation = presentToolCall(block.input, cwd)
        events.push({
          type: 'tool.call',
          seq: nextSeq(),
          anchor: str(frame.uuid),
          turn: attemptTurn,
          step: attemptStep,
          callId,
          name,
          argsJson,
          ...(presentation !== undefined ? { presentation } : {}),
          time,
          ...(frame.parent_tool_use_id ? { parentCallId: str(frame.parent_tool_use_id) } : {}),
        })
      }
    }

    events.push({
      type: 'assistant.message',
      seq: nextSeq(),
      anchor: str(frame.uuid),
      turn: attemptTurn,
      step: attemptStep,
      attemptId,
      time,
      model: str(message.model),
      blocks,
      usage: usageDelta(message.usage),
      canonical: true,
      ...(frame.parent_tool_use_id ? { parentCallId: str(frame.parent_tool_use_id) } : {}),
    })
    return events
  }

  function translateUserEcho(frame, time) {
    // stdin writes are not echoed back unless --replay-user-messages is on; a
    // user frame on stdout carries tool_result blocks for the running turn —
    // or, during the resume replay phase, the historical user message itself.
    if (frame.isReplay) return []
    const content = frame.message?.content
    const toolResultBlocks = Array.isArray(content)
      ? content.filter(block => block?.type === 'tool_result')
      : []
    if (toolResultBlocks.length > 0) {
      if (activeTurn === null) {
        debug('tool result outside a turn ignored')
        return []
      }
      return toolResultEvents(frame, toolResultBlocks, time)
    }
    if (replayMode) return translateReplayUser(frame, content, time)
    return [] // live mode: text user frames have no channel-side meaning
  }

  /** Shared tool_result → tool.result mapping (live echo and replay alike). */
  function toolResultEvents(frame, blocks, time) {
    const events = []
    for (const block of blocks) {
      const callId = str(block.tool_use_id) ?? ''
      const location = callLocation.get(callId) ?? { turn: activeTurn.number, step }
      const { content: raw, text: resultText } = toolResultContent(block.content)
      const isError = block.is_error === true
      // The settled card (bounded run-output tail for command-shaped calls);
      // the full text stays in the persistent record below.
      const presentation = presentToolResult(callInputs.get(callId), { isError, text: resultText }, text)
      events.push({
        type: 'tool.result',
        seq: nextSeq(),
        turn: location.turn,
        step: location.step,
        callId,
        isError,
        time,
        content: raw,
        text: resultText,
        ...(isError ? { errorText: resultText !== '' ? resultText : 'tool failed' } : {}),
        ...(presentation !== undefined ? { presentation } : {}),
        ...(frame.parent_tool_use_id ? { parentCallId: str(frame.parent_tool_use_id) } : {}),
      })
    }
    return events
  }

  /** Resume replay (ticket T5): a historical user frame re-opens its own turn
   *  and is RE-ANCHORED to the CLI's native uuid — the T2 leftover (live user
   *  rows anchor on the channel's clientMessageId) ends here: every replayed
   *  family anchors on the transcript's own identity, so the host's
   *  resume/rewind anchors are native across the whole seed. */
  function translateReplayUser(frame, content, time) {
    let text = ''
    const blocks = []
    if (typeof content === 'string') {
      text = content
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          blocks.push({ kind: 'text', text: block.text })
          text = text === '' ? block.text : `${text}\n${block.text}`
        }
      }
    }
    if (text === '' && blocks.length === 0) {
      debug('replay user frame without text ignored')
      return []
    }
    turn += 1
    step = 0
    activeTurn = { number: turn }
    const anchor = str(frame.uuid) ?? `replay-user-${turn}`
    // No seal() here — translate() seals every batch exactly once; a second
    // seal would re-audit the same seqs against their own fresh state.
    return [
      {
        type: 'user.message',
        seq: nextSeq(),
        anchor,
        id: anchor,
        turn: activeTurn.number,
        time,
        source: 'user',
        text,
        blocks,
      },
      { type: 'turn.start', turn: activeTurn.number, origin: 'user', userMessageId: anchor, time },
    ]
  }

  function translateResult(frame, time) {
    if (activeTurn === null) {
      debug('result outside a turn ignored')
      return []
    }
    // Deliberately NOT mapped: `frame._meta['codebuddy.ai/turnUsage']` repeats
    // the snapshot usage_update verbatim (credits doc) — mapping it would
    // double the credits event for the turn (translateUsageUpdate).
    const ended = activeTurn
    activeTurn = null
    const events = closeOpenAttempt('aborted', time)
    const usage = turnUsage(frame.usage)
    const cost = costReport(frame.total_cost_usd)
    events.push({
      type: 'turn.end',
      turn: ended.number,
      reason: turnEndReason(frame),
      time,
      ...(usage !== undefined ? { usage } : {}),
      ...(cost !== undefined ? { cost } : {}),
    })
    return events
  }

  function translateToolProgress(frame, time) {
    const callId = str(frame.tool_use_id) ?? ''
    // Only calls this translator issued itself (callId recorded at tool.call)
    // get progress — a foreign/unknown callId fabricates nothing.
    if (activeTurn === null || callId === '' || !callLocation.has(callId)) return []
    const elapsedMs = typeof frame.elapsed_time_seconds === 'number'
      ? Math.round(frame.elapsed_time_seconds * 1000)
      : undefined
    if (elapsedMs === undefined) return []
    return [{
      type: 'tool.progress',
      callId,
      elapsedMs,
      ...(frame.parent_tool_use_id ? { parentCallId: str(frame.parent_tool_use_id) } : {}),
    }]
  }

  /**
   * `result` → TurnEndReason. Determination basis for the "interrupt is also a
   * success" shape (T4, notes codebuddy-sdk §2.2 + §8, host-surface §1):
   *
   * The result subtype union has NO 'interrupted'/'hook_blocked' member —
   * a user interrupt still ends the turn as
   *   { type:'result', subtype:'success', is_error:false,
   *     terminal_reason:'interrupt', result:'' }   // result '' when nothing
   *                                                // had completed yet
   * `terminal_reason` is a runtime-only field (absent from the 0.3.307 .d.ts)
   * whose values come from the CLI's EXIT_REASONS tuple
   * ('user_exit'|'interrupt'|'error'|'end_turn'|'max_turns'|'max_budget_usd');
   * the error exits arrive as the error_* subtypes above, so here only the
   * success family is left to split:
   *   - terminal_reason 'interrupt'  → { kind:'interrupted' }  (Esc/cancel)
   *   - 'end_turn' or field absent   → { kind:'completed' }    (older CLIs may
   *     omit the runtime field entirely; absence must not read as a hang)
   *   - anything else                → { kind:'other', label } — an unknown
   *     CLI reason stays visible instead of masquerading as a completion.
   * The empty `result` string of an interrupted turn is a secondary hint, NOT
   * a test: a legitimately terse completion may also be short, so only the
   * explicit terminal_reason decides.
   */
  function turnEndReason(frame) {
    if (RESULT_ERROR_SUBTYPES.has(frame.subtype) || frame.is_error === true) {
      const errors = Array.isArray(frame.errors) ? frame.errors.filter(e => typeof e === 'string') : []
      return { kind: 'error', message: errors.join('; ') || str(frame.subtype) || 'error' }
    }
    const terminal = str(frame.terminal_reason)
    if (terminal === 'interrupt') return { kind: 'interrupted' }
    if (terminal === undefined || terminal === 'end_turn') return { kind: 'completed' }
    return { kind: 'other', label: terminal }
  }

  /** result.usage is session-cumulative; turn.end.usage wants the per-turn
   *  delta, so keep the running cumulative and diff it. */
  function turnUsage(cumulative) {
    const next = usageDelta(cumulative)
    if (next === undefined) return undefined
    const previous = cumulativeUsage ?? {}
    cumulativeUsage = next
    return {
      input: (next.input ?? 0) - (previous.input ?? 0),
      output: (next.output ?? 0) - (previous.output ?? 0),
    }
  }

  return {
    userSubmitted,
    translate,
    abandonTurn,
    /** Resume replay phase active (frames outside turns are history). */
    replayActive: () => replayMode,
    /** A replayed turn is still open (the settle must not cut a live one). */
    replayTurnOpen: () => replayMode && activeTurn !== null,
    /** End of the replay phase — the ONLY way it ends. Closes a dangling
     *  replayed turn (a transcript truncated before its result) as
     *  interrupted so live numbering continues cleanly, and flips to live
     *  mode. Idempotent. */
    settleReplay(time = now()) {
      if (!replayMode) return seal([])
      replayMode = false
      if (activeTurn === null) return seal([])
      const ended = activeTurn
      activeTurn = null
      const events = closeOpenAttempt('aborted', time)
      events.push({ type: 'turn.end', turn: ended.number, reason: { kind: 'interrupted' }, time })
      return seal(events)
    },
  }
}

// ── small decode helpers (unknown-tolerant by design) ──────────────────────

function str(value) {
  return typeof value === 'string' ? value : undefined
}

/** SDK Usage → the bundle's UsageDelta {input?, output?, cacheRead?, cacheWrite?}. */
function usageDelta(usage) {
  if (usage === null || typeof usage !== 'object') return undefined
  const out = {}
  if (typeof usage.input_tokens === 'number') out.input = usage.input_tokens
  if (typeof usage.output_tokens === 'number') out.output = usage.output_tokens
  if (typeof usage.cache_read_input_tokens === 'number') out.cacheRead = usage.cache_read_input_tokens
  if (typeof usage.cache_creation_input_tokens === 'number') out.cacheWrite = usage.cache_creation_input_tokens
  return Object.keys(out).length > 0 ? out : undefined
}

function costReport(amount) {
  return typeof amount === 'number' && Number.isFinite(amount)
    ? { amount, currency: 'USD', source: 'backend' }
    : undefined
}

/** tool_result content (string | ContentBlock[]) → {content: raw, text}. */
function toolResultContent(content) {
  if (typeof content === 'string') return { content, text: content }
  if (!Array.isArray(content)) return { content: undefined, text: '' }
  const texts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    else texts.push(JSON.stringify(block))
  }
  return { content, text: texts.join('\n') }
}
