/**
 * The CodeBuddy AgentSession — `backend.open()` lands here.
 *
 * Transport shape (docs/decisions.md MVP item 1 + ticket T2): ONE long-lived
 * `query()` per session, driven through the streaming-input protocol —
 * user messages flow into the CLI's stdin as an AsyncIterable (`streamInput`),
 * protocol frames flow back line-by-line.
 *
 * One deliberate reach-through, and why: `query()`'s own async iterator is a
 * ONE-SHOT API — its read loop breaks at the first `result` message and then
 * `cleanup()` closes the transport (query.js createIterator, verified against
 * SDK 0.3.307). A long-lived session must keep consuming after every result,
 * so this module consumes the transport's message stream directly
 * (`q.transport.messages()`) — the same sanctioned reach-through the notes use
 * for rewind (`query.transport.sendControlRequest`). Everything else stays on
 * the public surface: `query()` + `Options` construction, `connect()`
 * (spawn + initialize handshake), `streamInput()` for stdin writes.
 *
 * Session semantics:
 * - capabilities: the manifest declares permissions / models / images and the
 *   runtime provides exactly those three (test/capabilities.test.js pins the
 *   equality; ticket T6). models drives the SDK's supportedModels() +
 *   a direct set_model control request (see the capability below); images
 *   declares the composer limits and submit() maps AgentInput.images onto
 *   base64 image blocks (images.js);
 * - usage accounting (T6): usage_update frames surface credits through
 *   `custom` events (translator.js) while tokens book ONLY through
 *   assistant.message.usage — the turn-level and session-cumulative number
 *   families never double-add;
 * - subscribe: batch delivery with backlog replay for late subscribers
 *   (notes §2 convention);
 * - submit/placement: `turn` opens a turn when idle, FIFO-queues when busy;
 *   steer/followup queue (reported via pending.changed) — SDK 0.3.307 consumes
 *   the next stdin line only after the current result, so both deliver at the
 *   same point and the placement label keeps them distinct; `now` interrupts
 *   the running turn and takes the queue HEAD (T4) — see the four-semantics
 *   comment in submit();
 * - cancel: interrupt control request; SDK 0.3.307 has no turn-level receipt,
 *   so a running cancel is honestly `unknown` while idle is `confirmed`
 *   (the local queue IS the live queue) and a lost session is `failed` (T4);
 *   sendControlRequest must never be called on a lost transport — the SDK
 *   re-spawns the CLI (auto-start), see sendInterrupt();
 * - interrupt force-settle backstop (T4): if the CLI never answers the
 *   interrupt with a result, the turn is force-closed locally
 *   (turn.end{aborted} + localized warning notice) and the session keeps
 *   going — no permanent hang (claude's 30s precedent, recalibrated to 15s);
 * - dispose: stdin EOF closes the CLI (its own graceful shutdown; Windows
 *   backstop kill stays a backstop), synthesized turn end for the running
 *   turn, listeners left with a final session.status.
 */
import { randomUUID } from 'node:crypto'
import { createCodebuddyTranslator } from './translator.js'
import { createCodebuddyPrefs } from './prefs.js'
import { createCodebuddySettings } from './settings.js'
import { createCodebuddyPermissionBridge } from './permissions.js'
import { CODEBUDDY_IMAGE_LIMITS, codebuddyImageBlocks } from './images.js'
import { codebuddyText, localeOf } from './text.js'

const BACKEND_ID = 'codebuddy'

// Ack window for the interrupt control request. The SDK's own default is 60s
// (the initialize handshake scale); an interrupt ack that takes longer than
// 10s means the CLI is effectively gone — the session-level force-settle
// backstop (below) owns the turn from there.
const INTERRUPT_ACK_TIMEOUT_MS = 10_000

// Ack window for the set_model control request (ticket T6). Same scale and
// rationale as the interrupt window: a CLI that cannot ack a model switch
// within 10s is effectively gone. The ack is DELIVERY evidence — SDK 0.3.307
// exposes no "model accepted" receipt (q.setModel is fire-and-forget with a
// swallowed rejection, query.js), so `switched` honestly means "the switch
// reached the CLI and was acked", nothing stronger.
const MODEL_ACK_TIMEOUT_MS = 10_000

// Force-settle backstop for an interrupt the CLI never answers with a result
// (ticket T4: 不永久悬挂). Calibrated between the notes' reference durations:
// CBC_CLI_EXIT_GRACE_MS (8000 ms, the SDK's Windows EOF-exit grace) is the
// floor a dying CLI may still need; the SDK control-request handshake (60 s
// default) is the ceiling; claude's precedent settles interrupts at 30 s.
// 15 s sits above the process-exit grace and well below the handshake.
// Override with CB_INTERRUPT_SETTLE_MS (tests shrink it); 0 disables — the
// same opt-out convention as CBC_CLI_EXIT_GRACE_MS. Never fires on healthy
// turns: it is armed only when an interrupt is actually requested.
const DEFAULT_INTERRUPT_SETTLE_MS = 15_000

function interruptSettleMs() {
  const raw = Number(process.env.CB_INTERRUPT_SETTLE_MS)
  if (raw === 0) return Number.POSITIVE_INFINITY // explicit opt-out
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERRUPT_SETTLE_MS
}

function debugOf(host) {
  return message => {
    try {
      host?.debug?.(`dsh-tui-codebuddy: ${message}`)
    } catch {
      // a hostile debug sink must never break the session
    }
  }
}

/** Push-based async iterable of user messages — the stdin side of the
 *  streaming-input protocol. `streamInput` drains it concurrently with the
 *  read loop (it is an independent promise that may never resolve). */
function createInbox() {
  const DONE = Symbol('inbox-done')
  const buffer = []
  let waiting = null
  let closed = false
  return {
    push(message) {
      if (closed) return false
      if (waiting !== null) {
        const resolve = waiting
        waiting = null
        resolve(message)
      } else {
        buffer.push(message)
      }
      return true
    },
    close() {
      closed = true
      if (waiting !== null) {
        const resolve = waiting
        waiting = null
        resolve(DONE)
      }
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (buffer.length > 0) {
          yield buffer.shift()
        } else if (closed) {
          return
        } else {
          const item = await new Promise(resolve => {
            waiting = resolve
          })
          if (item === DONE) return
          yield item
        }
      }
    },
  }
}

export async function createCodebuddySession(target, host) {
  // The bilingual accessor bound to the LIVE host locale — the ONE route for
  // every user-visible string this session emits (notices, refusals, reasons,
  // translator card text). locale() is read per call (notes §11), so a /lang
  // switch applies to the next string; nothing is baked at open time.
  const localeText = (key, params) => codebuddyText(key, localeOf(host), params)
  const isResume = target?.kind === 'resume'
  if (!isResume && target?.kind !== 'create') {
    throw new Error('dsh-tui-codebuddy: open target must be kind "create" or "resume"')
  }
  const resumeId = isResume
    ? (typeof target.sessionId === 'string' && target.sessionId.trim() !== '' ? target.sessionId : null)
    : null
  if (isResume && resumeId === null) {
    // 响亮拒绝：没有有效会话 id 的 resume 不存在"猜一个"的路径。
    throw new Error(localeText('resume-invalid-target'))
  }
  const cwd = typeof target?.cwd === 'string' && target.cwd !== '' ? target.cwd : host?.cwd
  if (typeof cwd !== 'string' || cwd === '') {
    throw new Error('dsh-tui-codebuddy: open target needs a cwd')
  }
  const debug = debugOf(host)
  // lastSession memory (notes §2): the launcher's bare `--resume` reads this
  // store; the session records the CLI-confirmed session id the moment the
  // init frame confirms it. No dataDir → in-memory per host (never guessed).
  const prefs = createCodebuddyPrefs(host)
  // The model-choice memory (T6): the persisted `/model` selection applies to
  // the NEXT session open (host semantics: 设置改动作用于下一请求 — the closest
  // equivalent at open time); the live session additionally switches in
  // place through models.set (see the capability below).
  const settings = createCodebuddySettings(host)
  const savedModel = settings.model()

  // Lazy SDK import: the bundle module itself must stay side-effect-free and
  // light (the Loader imports it before detect/open); the SDK is only loaded
  // when a session really opens.
  const { query } = await import('@tencent-ai/agent-sdk')

  // Resume keeps the requested id as the session ref identity; create mints
  // one and the CLI echoes it back in the init frame.
  const sessionKey = isResume ? resumeId : randomUUID()
  // One translator for replay AND live (docs/decisions.md MVP item 2): the
  // replay phase seeds the same seq/turn counters the live stream continues.
  const translator = createCodebuddyTranslator({
    cwd,
    now: Date.now,
    debug,
    replay: isResume,
    // The card tail's dropped-lines marker is user-visible text — live locale.
    text: localeText,
  })

  // The approval bridge (ticket T3): prompts park here and surface as
  // permission.request / permission.settled; the answers become the
  // PermissionResult the CLI expects. deliver/emit is hoisted, so the bridge
  // can be built before the query that receives canUseTool.
  const bridge = createCodebuddyPermissionBridge({
    emit: deliver,
    debug,
    locale: () => localeOf(host),
    closing: () => disposed,
    onPendingChange: count => {
      if (disposed) return
      // Parked prompts mean the session needs the user; settling them means
      // back to running — but only while a turn is actually still open.
      if (count > 0) setStatus('requires-action')
      else if (turnActive) setStatus('running')
    },
  })

  // Options per the notes (§1): cwd; default permission mode (modes control is
  // T4); includePartialMessages to receive stream_event deltas; settingSources
  // untouched so the SDK sends `--setting-sources none` (full isolation from
  // filesystem settings). Resume passes `--resume <id>` (SDK §1) with NO
  // prompt: initialize carries hasPrompt:false, so the CLI replays the
  // persisted history into the stream without triggering a model response.
  // canUseTool is the approval bridge — without it the SDK auto-denies every
  // can_use_tool request.
  //
  // The handshake stderr is captured (last 2 KB): when the CLI dies during
  // the handshake the SDK's rejection reason can be as vague as "stdout
  // closed unexpectedly" (a close/exit race), and the resume failure must
  // carry the REAL cause — the CLI's own last words on stderr.
  let handshakeStderrActive = true
  let handshakeStderr = ''
  const stderrSink = data => {
    if (handshakeStderrActive) handshakeStderr = (handshakeStderr + String(data)).slice(-2000)
    try {
      (host?.stderr ?? host?.debug)?.(data)
    } catch {
      // diagnostics must never break the session
    }
  }
  let q
  try {
    q = query({
      options: {
        cwd,
        ...(isResume ? { resume: sessionKey } : { sessionId: sessionKey }),
        // The persisted /model choice (T6): applied to every session open —
        // `--model <id>` (Options.model, SDK §1) — so the selection survives
        // restarts. A session without a choice lets the CLI pick its default.
        ...(savedModel !== undefined ? { model: savedModel } : {}),
        permissionMode: 'default',
        includePartialMessages: true,
        canUseTool: bridge.canUseTool,
        stderr: stderrSink,
      },
    })
    // Spawn + initialize handshake; a missing/broken CLI fails LOUDLY here —
    // open() rejects instead of returning a half-alive session.
    await q.connect()
    handshakeStderrActive = false
  } catch (error) {
    handshakeStderrActive = false
    if (!isResume) throw error
    // 响亮失败（票面验收）：会话不存在 / CLI 不可用 / resume 被拒——不回落、
    // 不静默新建。SDK 的关闭原因 + CLI 的 stderr 尾巴一起给出真实原因。
    // The SDK acquires its process-level session lock inside initialize();
    // when the handshake fails the lock would leak and poison every later
    // resume of the same id in this process. Query.cleanup() is the SDK's own
    // teardown (releases the lock, closes the transport) and is synchronous —
    // q.return() is NOT usable here: it waits on the never-settling
    // initialize await and hangs the failure path.
    try {
      q?.cleanup?.()
    } catch {
      // teardown of a half-started query is best-effort here
    }
    if (q?.cleanup === undefined) {
      try {
        q?.transport?.close?.()
      } catch {
        // the transport may already be gone with the CLI process
      }
    }
    const reason = String(error?.message ?? error)
    const detail = handshakeStderr !== '' ? `${reason} | stderr: ${handshakeStderr.trim()}` : reason
    throw new Error(localeText('resume-failed', { detail }))
  }

  // ── session state ────────────────────────────────────────────────────────
  let disposed = false
  let dead = false // transport died without dispose()
  let status = 'starting'
  let cliSessionId = null // authoritative id from the init frame
  let currentModel = null // the active model, from the init frame then models.set
  let turnActive = false // a turn is open (drives the requires-action return)
  const listeners = new Set()
  let backlog = [] // batches emitted before any subscriber
  const queue = [] // {clientMessageId, text, blocks, placement}
  const inbox = createInbox()
  let settleTimer = null // interrupt force-settle backstop (armed per request)
  let interruptRequested = false // an interrupt is outstanding for the active turn

  // ── resume replay phase (ticket T5) ───────────────────────────────────────
  // Transcript events produced while the translator is in replay mode are the
  // history seed: they go to replaySeed and reach the channel exactly once,
  // through history() — never through subscribe (先画历史再接 live). Only
  // session-family events (ready/status/notices) stay on the live stream.
  let replaySeed = []
  let seedHanded = false
  let settlePromise = null
  let frameCount = 0
  const REPLAY_QUIESCE_MS = 120 // stdout silence window that ends the replay
  const REPLAY_SETTLE_MAX_MS = 5000 // hard cap: never wait forever on a CLI
  const REPLAY_LIVE_TYPES = new Set(['session.ready', 'session.status', 'notice', 'pending.changed', 'session.title'])

  /** Deliver events: routed to the replay seed while the replay phase is
   *  active, otherwise dispatched to subscribers/backlog. */
  function deliver(events) {
    if (!Array.isArray(events) || events.length === 0) return
    for (const event of events) {
      if (event.type === 'session.ready' && event.sessionId) {
        cliSessionId = event.sessionId
        try {
          prefs.setLastSession(cliSessionId)
        } catch (error) {
          debug(`lastSession recording failed: ${error?.message}`)
        }
      }
      // The CLI's own model report (init frame) is the first truth for
      // models.current(); models.set() overrides it from there.
      if (event.type === 'session.ready' && typeof event.model === 'string' && event.model !== '' && currentModel === null) {
        currentModel = event.model
      }
    }
    if (translator.replayActive()) {
      const seedPart = []
      const livePart = []
      for (const event of events) {
        (REPLAY_LIVE_TYPES.has(event.type) ? livePart : seedPart).push(event)
      }
      if (seedPart.length > 0) replaySeed.push(...seedPart)
      if (livePart.length > 0) dispatch(livePart)
      return
    }
    dispatch(events)
  }

  function dispatch(events) {
    const onlyDeltas = events.every(event => event.type === 'assistant.delta')
    const meta = { replay: false, wake: onlyDeltas ? 'frame' : 'sync' }
    if (listeners.size === 0) {
      backlog.push(events)
      return
    }
    for (const listener of listeners) safeDeliver(listener, events, meta)
  }

  function safeDeliver(listener, events, meta) {
    try {
      listener(events, meta)
    } catch (error) {
      debug(`listener threw: ${error?.message}`)
    }
  }

  function setStatus(next) {
    if (status === next) return
    status = next
    deliver([{ type: 'session.status', status: next }])
  }

  // ── placement queue ──────────────────────────────────────────────────────
  const PENDING_PLACEMENTS = new Set(['steer', 'followup'])
  let lastPendingKey = '[]'

  function pendingItems() {
    return queue
      .filter(item => PENDING_PLACEMENTS.has(item.placement))
      .map(item => ({ id: item.clientMessageId, text: item.text ?? '', placement: item.placement }))
  }

  /** pending.changed is snapshot-replacement (notes §1); only emitted when the
   *  pending-listed set actually changed. */
  function syncPending(extra = {}) {
    const key = JSON.stringify(pendingItems())
    if (key === lastPendingKey && extra.dropped !== true) return
    lastPendingKey = key
    deliver([{ type: 'pending.changed', items: pendingItems(), ...extra }])
  }

  function beginTurn(item) {
    const events = translator.userSubmitted({
      text: item.text,
      blocks: item.blocks,
      clientMessageId: item.clientMessageId,
      ...(item.images !== undefined ? { images: item.images } : {}),
    })
    turnActive = true
    deliver(events) // user.message + turn.start
    setStatus('running')
    // Write stdin AFTER the events are out so the channel sees the submit pair
    // first no matter how fast the CLI answers.
    inbox.push(userMessageFrame(item))
  }

  /** A turn just ended: the outstanding interrupt settle is moot — drop it,
   *  back to idle, then run the next queued input. During the resume replay
   *  phase a turn.end is a HISTORICAL turn closing — queued live inputs must
   *  wait for the phase to end (the history() settle), or their stdin write
   *  would interleave with the CLI's replay output and the translator could
   *  not tell replay frames from live ones. */
  function drainQueue() {
    clearInterruptSettle()
    if (disposed) return
    if (translator.replayActive()) return
    setStatus('idle')
    const next = queue.shift()
    if (next === undefined) return
    syncPending()
    beginTurn(next)
  }

  // ── interrupt force-settle backstop (ticket T4: 不永久悬挂) ──────────────
  /** Arm the settle timer for a turn that was asked to interrupt. It fires
   *  only while that turn is still running — a healthy CLI answers the
   *  interrupt with a result in seconds and the timer is dropped at turn end
   *  (drainQueue). Healthy turns WITHOUT an interrupt never arm it, so long
   *  model/tool work is never killed by this clock. */
  function armInterruptSettle() {
    const ms = interruptSettleMs()
    // turnActive covers 'running' AND 'requires-action' (an approval-stalled
    // turn is just as interruptible — T3's state model).
    if (settleTimer !== null || disposed || !turnActive || ms === Number.POSITIVE_INFINITY) return
    settleTimer = setTimeout(() => {
      settleTimer = null
      if (disposed || !turnActive) return
      // If the pump already closed the turn (dead transport path) there is
      // nothing left to settle and no notice to fabricate.
      const events = translator.abandonTurn({ kind: 'aborted' })
      if (events.length === 0) return
      interruptRequested = false
      debug(`interrupt settle timeout (${ms} ms) — force-settling the running turn`)
      deliver([{ type: 'notice', level: 'warning', text: localeText('interrupt-forced-notice', { seconds: Math.ceil(ms / 1000) }) }])
      deliver(events)
      drainQueue() // the session keeps going: kept/`now` inputs still run
    }, ms)
    settleTimer.unref?.()
  }

  function clearInterruptSettle() {
    if (settleTimer !== null) {
      clearTimeout(settleTimer)
      settleTimer = null
    }
    interruptRequested = false
  }

  function userMessageFrame(item) {
    return {
      type: 'user',
      session_id: '',
      message: { role: 'user', content: buildContent(item) },
      parent_tool_use_id: null,
    }
  }

  /** AgentInput → the stream-json user content. Text stays a plain string;
   *  declared blocks map onto ContentBlock shapes, unknown kinds are skipped
   *  with debug; validated image attachments (T6) land as the SDK's base64
   *  image blocks after the text. */
  function buildContent(item) {
    const mapped = []
    if (typeof item.text === 'string' && item.text !== '') mapped.push({ type: 'text', text: item.text })
    for (const block of Array.isArray(item.blocks) ? item.blocks : []) {
      if (block?.kind === 'text' && typeof block.text === 'string') {
        mapped.push({ type: 'text', text: block.text })
      } else {
        debug(`unsupported input block kind ${JSON.stringify(block?.kind)} skipped`)
      }
    }
    // Image blocks were validated + encoded at submit time (codebuddyImageBlocks).
    for (const block of Array.isArray(item.imageBlocks) ? item.imageBlocks : []) {
      mapped.push(block)
    }
    if (mapped.length === 0) return ''
    if (mapped.length === 1 && mapped[0].type === 'text') return mapped[0].text
    return mapped
  }

  // ── transport-side flows ─────────────────────────────────────────────────
  const streamInputDone = q
    .streamInput(inbox)
    .catch(error => debug(`streamInput ended: ${error?.message}`))

  function sendInterrupt() {
    // Guard the SDK's auto-restart footgun (verified against 0.3.307
    // process-transport.js): sendControlRequest begins with `this.start()`,
    // which re-spawns the CLI whenever `process` is null — INCLUDING when the
    // previous CLI already died. A cancel on a lost session must never
    // conjure a fresh CLI process out of thin air, so a dead/disposed
    // transport is reported 'failed' without touching it.
    if (disposed || dead) return 'failed'
    // SDK 0.3.307 has no interrupt receipt — the CLI ends the interrupted turn
    // with a success result carrying terminal_reason:'interrupt' (notes §2.2),
    // which the translator maps to turn.end{interrupted}. Arm the force-settle
    // backstop now: if the result never comes, the turn still ends (locally)
    // instead of hanging forever. Even a failed send arms it — the "CLI never
    // replies" case is exactly what the backstop exists for.
    interruptRequested = true
    armInterruptSettle()
    try {
      // Short ack window: a dying CLI cannot ack, and the SDK's default 60s
      // request timer would then outlive the turn it was meant to end. (The
      // ack is delivery evidence, NOT a queue receipt — see cancel().)
      q.transport
        .sendControlRequest({
          subtype: 'interrupt',
          ...(cliSessionId ? { session_id: cliSessionId } : {}),
          reason: 'user interrupt',
        }, INTERRUPT_ACK_TIMEOUT_MS)
        .then(undefined, error => debug(`interrupt control request failed: ${error?.message}`))
      return 'sent'
    } catch (error) {
      debug(`interrupt failed: ${error?.message}`)
      return 'failed'
    }
  }

  function failNotice(detail) {
    return { type: 'notice', level: 'error', text: localeText('cli-exited-notice', { detail }) }
  }

  const pumpDone = (async () => {
    try {
      for await (const message of q.transport.messages()) {
        if (disposed) break
        frameCount += 1
        try {
          const events = translator.translate(message)
          deliver(events)
          if (events.some(event => event.type === 'turn.end')) {
            turnActive = false
            if (!disposed) drainQueue()
          }
        } catch (error) {
          // A mapping/invariant bug must not kill the pump silently: localized
          // notice, synthesized error turn end, session stays alive.
          const detail = String(error?.message ?? error)
          debug(`translate failed: ${detail}`)
          deliver([{ type: 'notice', level: 'error', text: localeText('internal-error-notice', { detail }) }])
          turnActive = false
          deliver(translator.abandonTurn({ kind: 'error', message: detail }))
          if (!disposed) drainQueue()
        }
      }
      if (!disposed) {
        // stdout closed without dispose(): the CLI died under us.
        dead = true
        turnActive = false
        bridge.settleAll()
        deliver([failNotice('stream closed')])
        deliver(translator.abandonTurn({ kind: 'error', message: 'CLI process exited' }))
      }
    } catch (error) {
      if (!disposed) {
        dead = true
        turnActive = false
        bridge.settleAll()
        const detail = String(error?.message ?? error)
        deliver([failNotice(detail)])
        deliver(translator.abandonTurn({ kind: 'error', message: detail }))
      }
    }
  })()

  // ── the four verbs ───────────────────────────────────────────────────────
  async function submit(input, placement = 'turn') {
    if (disposed) return { accepted: false, reason: localeText('submit-after-dispose') }
    if (dead) return { accepted: false, reason: localeText('session-dead') }
    const text = typeof input?.text === 'string' ? input.text : ''
    const hasBlocks = Array.isArray(input?.blocks) && input.blocks.length > 0
    const images = Array.isArray(input?.images) ? input.images : []
    if (text === '' && !hasBlocks && images.length === 0) {
      return { accepted: false, reason: localeText('submit-empty') }
    }
    // Images (T6): read back and checked against the limits ONCE MORE at
    // submit (claude's convention — a limit change, a foreign facade); a
    // violation refuses the WHOLE message with the localized reason, never a
    // message silently missing an image. Encoded at submit time: queued
    // placements (steer/followup/now) carry their payload with them, and the
    // stdin write at beginTurn stays synchronous.
    let imageBlocks = []
    if (images.length > 0) {
      try {
        imageBlocks = await codebuddyImageBlocks(images, CODEBUDDY_IMAGE_LIMITS, localeText)
      } catch (error) {
        return { accepted: false, reason: String(error?.message ?? error) }
      }
    }
    const clientMessageId = typeof input?.clientMessageId === 'string' && input.clientMessageId !== ''
      ? input.clientMessageId
      : `cb-${randomUUID()}`
    const kind = placement === 'steer' || placement === 'followup' || placement === 'now' ? placement : 'turn'
    const item = {
      clientMessageId,
      text,
      blocks: input?.blocks,
      ...(images.length > 0 ? { images, imageBlocks } : {}),
      placement: kind,
    }
    // Gate on turnActive (not `status === 'running'`): during
    // 'requires-action' the current turn is stalled on an approval but still
    // open — steer/followup must queue and `now` must interrupt it, same as
    // any running turn. OR the resume replay phase is still in flight: queue
    // (the replay phase's settle releases the queue — see drainQueue); a
    // `now` during replay takes the head of the queue WITHOUT firing an
    // interrupt, because there is no live turn to interrupt yet.
    if (turnActive || translator.replayActive()) {
      if (kind === 'now') {
        // Four-semantics table (host-surface notes §2): `now` = 打断当前回合
        // 立即投递. SDK 0.3.307's streamInput has no priority channel (claude's
        // priority 'now' has no counterpart here), so "immediately" lands as:
        // the interrupt goes out NOW and this input takes the HEAD of the
        // queue — ahead of any steer/followup already waiting — becoming the
        // very next turn the moment the interrupted turn closes. Its submit
        // pair (user.message + turn.start) is emitted only then, which keeps
        // turn numbering monotonic for the channel (no interleaved turn
        // ends). If the CLI never answers the interrupt, the force-settle
        // backstop closes the turn and drainQueue starts this input anyway —
        // the urgent message is never lost to a hung CLI. Interrupting an
        // approval-stalled turn also withdraws the panel (zero parked prompts
        // make settleAll a no-op).
        if (turnActive) {
          sendInterrupt()
          bridge.settleAll()
        }
        queue.unshift(item)
      } else {
        // steer/followup: join the queue behind whatever is waiting. With
        // SDK 0.3.307 the CLI consumes the next stdin line only after the
        // current result (notes §3), so both placements deliver at the same
        // point — the placement label (pending.changed) keeps them distinct
        // for the channel.
        queue.push(item)
      }
      syncPending()
      return { accepted: true }
    }
    // turn / followup / now when idle all open the next turn directly
    // (notes §2: 空闲时等同普通 push).
    beginTurn(item)
    return { accepted: true }
  }

  async function cancel(cause = 'user') {
    // Receipt semantics (notes §2, ticket T4): outcome 'confirmed' is the ONLY
    // value a channel may read as "the live queue is now empty" — it is a
    // backend-queue snapshot. 'unknown' and 'failed' leave stillQueued as a
    // REQUEST-TIME snapshot that must never be read as "queue empty".
    const stillQueued = () => queue.map(item => item.clientMessageId)
    if (disposed) return { stillQueued: stillQueued(), outcome: 'failed' }
    if (dead) {
      // There is no CLI left to cancel; a failed cancel must not read as
      // confirmed (that would claim a queue state nobody maintains anymore).
      return { stillQueued: stillQueued(), outcome: 'failed' }
    }
    const leaving = cause === 'interrupt' || cause === 'switch' || cause === 'dispose'
    const hadPending = queue.some(item => PENDING_PLACEMENTS.has(item.placement))
    if (leaving) {
      // interrupt 还要求丢弃队列输入（notes §2）：dropped:true 让 channel 把
      // 文本保留成 held row 供用户重发。
      for (const item of queue.splice(0)) debug(`dropped queued input ${item.clientMessageId} (cancel ${cause})`)
      // 离开即撤回挂起审批（T3 面板不悬挂）：SDK 0.3.307 的 abort 信号不会因
      // 这条自造 interrupt 触发，桥自己收口， settled 事件先进 channel。
      bridge.settleAll()
    }
    // 回合在飞（T3 语义：审批挂起 requires-action 也算——interrupt 同样要
    // 收掉它，settleAll 已在上面收口审批面板）。
    const running = turnActive
    const sent = running ? sendInterrupt() : undefined
    syncPending(leaving && hadPending ? { dropped: true } : {})
    return {
      stillQueued: stillQueued(),
      // running: SDK 0.3.307 回执只有 control ack（送达证据），没有任何机制
      // 回答"回合/队列真的停了吗"——诚实值是 unknown；连 ack 请求都发不出去
      // 则是 failed（cancel 本身失败）。idle：没有在途操作，本地队列就是
      // 活队列，confirmed 是真实快照。
      outcome: running ? (sent === 'sent' ? 'unknown' : 'failed') : 'confirmed',
    }
  }

  let disposePromise = null
  async function dispose() {
    if (disposePromise) return disposePromise
    disposePromise = (async () => {
      disposed = true
      // The force-settle backstop must not fire into a session being torn
      // down — dispose synthesizes its own turn end below.
      clearInterruptSettle()
      // Synthesize the running turn's end locally — the CLI will never send a
      // result for it now. Delivered BEFORE the transport closes so the
      // channel sees the turn end.
      turnActive = false
      deliver(translator.abandonTurn({ kind: 'aborted', cause: 'disposed' }))
      // Pending approvals settle (cancelled) BEFORE the query closes so the
      // settled events reach the channel and the panel never hangs.
      bridge.settleAll()
      inbox.close()
      try {
        // stdin EOF lets the CLI run its own graceful shutdown (the SDK keeps
        // a Windows backstop kill as a last resort — the stub exits on EOF).
        q.transport.close()
      } catch (error) {
        debug(`transport close failed: ${error?.message}`)
      }
      const settle = new Promise(resolve => {
        const timer = setTimeout(resolve, 1000)
        timer.unref?.()
      })
      await Promise.race([pumpDone, settle])
      await Promise.race([streamInputDone, settle])
      setStatus('disposed')
    })()
    return disposePromise
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {}
    listeners.add(listener)
    const pendingBatches = backlog
    backlog = []
    if (pendingBatches.length > 0) {
      queueMicrotask(() => {
        // 迟订阅者补发（notes §2 范式）：订阅前产生的批次一次性补上。
        if (listeners.has(listener)) {
          for (const batch of pendingBatches) safeDeliver(listener, batch, { replay: false, wake: 'sync' })
        }
      })
    }
    return () => {
      listeners.delete(listener)
    }
  }

  /** Wait until the resume replay stream has settled: the stdout silence
   *  window passed with no new frames AND no replayed turn still open. A
   *  truncated transcript (dangling turn, no frames coming) settles at the
   *  hard cap; dispose/death settles immediately with what arrived. */
  async function awaitReplaySettled() {
    const deadline = Date.now() + REPLAY_SETTLE_MAX_MS
    while (Date.now() < deadline && !disposed && !dead) {
      const before = frameCount
      await new Promise(resolve => setTimeout(resolve, REPLAY_QUIESCE_MS))
      if (frameCount === before && !translator.replayTurnOpen()) return
    }
  }

  async function history() {
    // 回放种子约定（notes §2）：一次性交接。新建会话返回 []；resume 先等到
    // 回放流 settle，把经同一翻译器修好编号的转录事件（含悬挂回合的强制
    // 收口）整批交出，之后置空——长转录不随会话存活。并发首次调用共享同一次
    // settle；交接之后再问一律 []。
    if (!isResume) return []
    if (seedHanded) return []
    if (settlePromise === null) {
      settlePromise = (async () => {
        await awaitReplaySettled()
        const settleEvents = translator.settleReplay()
        if (settleEvents.length > 0) replaySeed.push(...settleEvents)
        seedHanded = true
        const seed = replaySeed
        replaySeed = [] // 交出后释放：长转录不随会话存活
        drainQueue() // 放行回放期间排队等待的 live 输入
        return seed
      })()
    }
    return settlePromise
  }

  // ── the models capability (ticket T6) ────────────────────────────────────
  // SDK basis (codebuddy-sdk notes §4): `q.supportedModels()` re-issues the
  // initialize control request and answers `{value, displayName, description}`
  // — the public, sanctioned list path. The RUNTIME switch: SDK 0.3.307's
  // `q.setModel()` is useless in this wiring — it only sends set_model when
  // `q._sessionId` is set, and that field is captured inside the query()'s own
  // read iterator, which this session deliberately bypasses (ONE long-lived
  // transport read loop; see the module header). So the switch goes out as the
  // same direct control request the interrupt path uses
  // (`q.transport.sendControlRequest`), awaiting the CLI's ack as delivery
  // evidence. The CLI's acceptance is not observable (fire-and-forget in the
  // SDK; no receipt subtype), so `switched` means delivered+acked, honestly.
  /** list(): dead/disposed sessions must NEVER touch the transport — the SDK
   *  re-spawns the CLI on control requests to a dead process (auto-start
   *  footgun, same guard as sendInterrupt) — so they fail loudly instead. */
  async function listModels() {
    if (disposed || dead) {
      throw new Error(localeText('models-list-unavailable'))
    }
    const infos = await q.supportedModels()
    return (Array.isArray(infos) ? infos : [])
      .filter(info => info !== null && typeof info === 'object' && typeof info.value === 'string' && info.value !== '')
      .map(info => ({
        provider: 'codebuddy',
        id: info.value,
        label: typeof info.displayName === 'string' && info.displayName !== '' ? info.displayName : info.value,
        ...(typeof info.description === 'string' && info.description !== '' ? { description: info.description } : {}),
      }))
  }

  /** set(ref): validate → deliver the set_model control request (acked) →
   *  persist to the backend's own settings store (applies to the NEXT session
   *  open) → mirror the host's model.changed vocabulary. Refusals carry the
   *  localized reason. */
  async function setModel(ref) {
    const model = ref !== null && typeof ref === 'object' && typeof ref.model === 'string' ? ref.model : undefined
    if (model === undefined || model === '') {
      return { kind: 'refused', reason: localeText('model-invalid-ref') }
    }
    if (disposed || dead) {
      return { kind: 'refused', reason: localeText('session-dead') }
    }
    try {
      await q.transport.sendControlRequest({
        subtype: 'set_model',
        ...(cliSessionId ? { session_id: cliSessionId } : {}),
        model,
      }, MODEL_ACK_TIMEOUT_MS)
    } catch (error) {
      return { kind: 'refused', reason: localeText('model-refused', { detail: String(error?.message ?? error) }) }
    }
    currentModel = model
    try {
      settings.setModel(model)
    } catch (error) {
      debug(`model choice persistence failed: ${error?.message}`)
    }
    deliver([{ type: 'model.changed', model, provider: 'codebuddy', source: 'user' }])
    return { kind: 'switched' }
  }

  return {
    ref: { backendId: BACKEND_ID, sessionId: sessionKey },
    get cwd() {
      return cwd
    },
    get status() {
      return status
    },
    // 每个成员缺席＝明确"不支持"（notes §3）；capabilities 与 manifest 声明
    // （permissions / models / images）完全一致，一致性由
    // test/capabilities.test.js 钉住。permissions 是 T3 的审批能力：respond
    // 把面板决策送回 CLI，pending 列出仍挂起的请求（重开面板用）。models
    // （T6）与 images limits（T6）见上方各自的说明。
    capabilities: {
      permissions: {
        respond: bridge.respond,
        pending: () => bridge.pendingViews(),
      },
      models: {
        list: listModels,
        current: () => ({ provider: 'codebuddy', model: currentModel ?? '' }),
        set: setModel,
      },
      images: {
        limits: CODEBUDDY_IMAGE_LIMITS,
      },
    },
    history,
    subscribe,
    submit,
    cancel,
    dispose,
  }
}
