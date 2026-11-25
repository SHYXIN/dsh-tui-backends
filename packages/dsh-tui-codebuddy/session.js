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
import { codebuddyText } from './text.js'

const BACKEND_ID = 'codebuddy'

// Ack window for the interrupt control request. The SDK's own default is 60s
// (the initialize handshake scale); an interrupt ack that takes longer than
// 10s means the CLI is effectively gone — the session-level force-settle
// backstop (below) owns the turn from there.
const INTERRUPT_ACK_TIMEOUT_MS = 10_000

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

function localeOf(host) {
  try {
    return host?.locale?.() === 'en' ? 'en' : 'zh'
  } catch {
    return 'zh'
  }
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
  if (target?.kind !== 'create') {
    // 响亮拒绝：resume 的转录回放 + `--resume` 启动在 T5 落地；绝不静默回退新会话。
    throw new Error(codebuddyText('resume-not-implemented', localeOf(host)))
  }
  const cwd = typeof target.cwd === 'string' && target.cwd !== '' ? target.cwd : host?.cwd
  if (typeof cwd !== 'string' || cwd === '') {
    throw new Error('dsh-tui-codebuddy: open target needs a cwd')
  }
  const debug = debugOf(host)

  // Lazy SDK import: the bundle module itself must stay side-effect-free and
  // light (the Loader imports it before detect/open); the SDK is only loaded
  // when a session really opens.
  const { query } = await import('@tencent-ai/agent-sdk')

  const sessionKey = randomUUID()
  const translator = createCodebuddyTranslator({ cwd, now: Date.now, debug })

  // Options per the notes (§1): cwd; default permission mode (modes control is
  // T4); includePartialMessages to receive stream_event deltas; settingSources
  // untouched so the SDK sends `--setting-sources none` (full isolation from
  // filesystem settings); our session id up front so ref.sessionId is known at
  // open time and the init frame echoes it back. No canUseTool yet — approvals
  // are T3; a can_use_tool request without a handler is auto-denied by the SDK.
  const q = query({
    options: {
      cwd,
      sessionId: sessionKey,
      permissionMode: 'default',
      includePartialMessages: true,
      stderr: data => {
        try {
          (host?.stderr ?? host?.debug)?.(data)
        } catch {
          // diagnostics must never break the session
        }
      },
    },
  })

  // Spawn + initialize handshake; a missing/broken CLI fails LOUDLY here —
  // open() rejects instead of returning a half-alive session.
  await q.connect()

  // ── session state ────────────────────────────────────────────────────────
  let disposed = false
  let dead = false // transport died without dispose()
  let status = 'starting'
  let cliSessionId = null // authoritative id from the init frame
  const listeners = new Set()
  let backlog = [] // batches emitted before any subscriber
  const queue = [] // {clientMessageId, text, blocks, placement}
  const inbox = createInbox()
  let settleTimer = null // interrupt force-settle backstop (armed per request)
  let interruptRequested = false // an interrupt is outstanding for the active turn

  function deliver(events) {
    if (!Array.isArray(events) || events.length === 0) return
    for (const event of events) {
      if (event.type === 'session.ready' && event.sessionId) cliSessionId = event.sessionId
    }
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
    })
    deliver(events) // user.message + turn.start
    setStatus('running')
    // Write stdin AFTER the events are out so the channel sees the submit pair
    // first no matter how fast the CLI answers.
    inbox.push(userMessageFrame(item))
  }

  /** A turn just ended: the outstanding interrupt settle is moot — drop it,
   *  back to idle, then run the next queued input. */
  function drainQueue() {
    clearInterruptSettle()
    if (disposed) return
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
    if (settleTimer !== null || disposed || status !== 'running' || ms === Number.POSITIVE_INFINITY) return
    settleTimer = setTimeout(() => {
      settleTimer = null
      if (disposed || status !== 'running') return
      // If the pump already closed the turn (dead transport path) there is
      // nothing left to settle and no notice to fabricate.
      const events = translator.abandonTurn({ kind: 'aborted' })
      if (events.length === 0) return
      interruptRequested = false
      debug(`interrupt settle timeout (${ms} ms) — force-settling the running turn`)
      deliver([{ type: 'notice', level: 'warning', text: codebuddyText('interrupt-forced-notice', localeOf(host), { seconds: Math.ceil(ms / 1000) }) }])
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
   *  with debug (images land with the images capability work). */
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
    if (mapped.length === 0) return ''
    if (mapped.length === 1) return mapped[0].text
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
    return { type: 'notice', level: 'error', text: codebuddyText('cli-exited-notice', localeOf(host), { detail }) }
  }

  const pumpDone = (async () => {
    try {
      for await (const message of q.transport.messages()) {
        if (disposed) break
        try {
          const events = translator.translate(message)
          deliver(events)
          if (!disposed && events.some(event => event.type === 'turn.end')) drainQueue()
        } catch (error) {
          // A mapping/invariant bug must not kill the pump silently: localized
          // notice, synthesized error turn end, session stays alive.
          const detail = String(error?.message ?? error)
          debug(`translate failed: ${detail}`)
          deliver([{ type: 'notice', level: 'error', text: codebuddyText('internal-error-notice', localeOf(host), { detail }) }])
          deliver(translator.abandonTurn({ kind: 'error', message: detail }))
          if (!disposed) drainQueue()
        }
      }
      if (!disposed) {
        // stdout closed without dispose(): the CLI died under us.
        dead = true
        deliver([failNotice('stream closed')])
        deliver(translator.abandonTurn({ kind: 'error', message: 'CLI process exited' }))
      }
    } catch (error) {
      if (!disposed) {
        dead = true
        const detail = String(error?.message ?? error)
        deliver([failNotice(detail)])
        deliver(translator.abandonTurn({ kind: 'error', message: detail }))
      }
    }
  })()

  // ── the four verbs ───────────────────────────────────────────────────────
  async function submit(input, placement = 'turn') {
    const locale = localeOf(host)
    if (disposed) return { accepted: false, reason: codebuddyText('submit-after-dispose', locale) }
    if (dead) return { accepted: false, reason: codebuddyText('session-dead', locale) }
    const text = typeof input?.text === 'string' ? input.text : ''
    const hasBlocks = Array.isArray(input?.blocks) && input.blocks.length > 0
    if (text === '' && !hasBlocks) {
      return { accepted: false, reason: codebuddyText('submit-empty', locale) }
    }
    const clientMessageId = typeof input?.clientMessageId === 'string' && input.clientMessageId !== ''
      ? input.clientMessageId
      : `cb-${randomUUID()}`
    const kind = placement === 'steer' || placement === 'followup' || placement === 'now' ? placement : 'turn'
    const item = { clientMessageId, text, blocks: input?.blocks, placement: kind }
    if (status === 'running') {
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
        // the urgent message is never lost to a hung CLI.
        sendInterrupt()
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
    }
    const running = status === 'running'
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
      deliver(translator.abandonTurn({ kind: 'aborted', cause: 'disposed' }))
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

  async function history() {
    // 回放种子约定（notes §2）：新建会话返回 []。resume（T5）会把经同一翻译器
    // 修好编号的转录事件从这里一次性交出，之后不再随会话存活。
    return []
  }

  return {
    ref: { backendId: BACKEND_ID, sessionId: sessionKey },
    get cwd() {
      return cwd
    },
    get status() {
      return status
    },
    // 每个成员缺席＝明确"不支持"（notes §3）；permissions 能力 T3 接入后加入。
    capabilities: {},
    history,
    subscribe,
    submit,
    cancel,
    dispose,
  }
}
