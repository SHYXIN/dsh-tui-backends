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
 * Session semantics implemented in this ticket:
 * - subscribe: batch delivery with backlog replay for late subscribers
 *   (notes §2 convention);
 * - submit/placement: `turn` opens a turn when idle, FIFO-queues when busy;
 *   steer/followup queue (reported via pending.changed); `now` interrupts the
 *   running turn and jumps the queue — full mid-turn injection needs a CLI
 *   priority channel that SDK 0.3.307's streamInput does not have, T4 refines;
 * - cancel: interrupt control request; no interrupt receipt exists in
 *   SDK 0.3.307, so the receipt is honestly `unknown` while running;
 * - dispose: stdin EOF closes the CLI (its own graceful shutdown; Windows
 *   backstop kill stays a backstop), synthesized turn end for the running
 *   turn, listeners left with a final session.status.
 */
import { randomUUID } from 'node:crypto'
import { createCodebuddyTranslator } from './translator.js'
import { createCodebuddyPrefs } from './prefs.js'
import { codebuddyText } from './text.js'

const BACKEND_ID = 'codebuddy'

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
  const locale = localeOf(host)
  const isResume = target?.kind === 'resume'
  if (!isResume && target?.kind !== 'create') {
    throw new Error('dsh-tui-codebuddy: open target must be kind "create" or "resume"')
  }
  const resumeId = isResume
    ? (typeof target.sessionId === 'string' && target.sessionId.trim() !== '' ? target.sessionId : null)
    : null
  if (isResume && resumeId === null) {
    // 响亮拒绝：没有有效会话 id 的 resume 不存在"猜一个"的路径。
    throw new Error(codebuddyText('resume-invalid-target', locale))
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

  // Lazy SDK import: the bundle module itself must stay side-effect-free and
  // light (the Loader imports it before detect/open); the SDK is only loaded
  // when a session really opens.
  const { query } = await import('@tencent-ai/agent-sdk')

  // Resume keeps the requested id as the session ref identity; create mints
  // one and the CLI echoes it back in the init frame.
  const sessionKey = isResume ? resumeId : randomUUID()
  // One translator for replay AND live (docs/decisions.md MVP item 2): the
  // replay phase seeds the same seq/turn counters the live stream continues.
  const translator = createCodebuddyTranslator({ cwd, now: Date.now, debug, replay: isResume })

  // Options per the notes (§1): cwd; default permission mode (modes control is
  // T4); includePartialMessages to receive stream_event deltas; settingSources
  // untouched so the SDK sends `--setting-sources none` (full isolation from
  // filesystem settings). Resume passes `--resume <id>` (SDK §1) with NO
  // prompt: initialize carries hasPrompt:false, so the CLI replays the
  // persisted history into the stream without triggering a model response.
  // No canUseTool yet — approvals are T3; a can_use_tool request without a
  // handler is auto-denied by the SDK.
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
        permissionMode: 'default',
        includePartialMessages: true,
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
    throw new Error(codebuddyText('resume-failed', locale, { detail }))
  }

  // ── session state ────────────────────────────────────────────────────────
  let disposed = false
  let dead = false // transport died without dispose()
  let status = 'starting'
  let cliSessionId = null // authoritative id from the init frame
  const listeners = new Set()
  let backlog = [] // batches emitted before any subscriber
  const queue = [] // {clientMessageId, text, blocks, placement}
  const inbox = createInbox()

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
    })
    deliver(events) // user.message + turn.start
    setStatus('running')
    // Write stdin AFTER the events are out so the channel sees the submit pair
    // first no matter how fast the CLI answers.
    inbox.push(userMessageFrame(item))
  }

  /** A turn just ended: back to idle, then run the next queued input. During
   *  the resume replay phase a turn.end is a HISTORICAL turn closing — queued
   *  live inputs must wait for the phase to end (the history() settle), or
   *  their stdin write would interleave with the CLI's replay output and the
   *  translator could not tell replay frames from live ones. */
  function drainQueue() {
    if (disposed) return
    if (translator.replayActive()) return
    setStatus('idle')
    const next = queue.shift()
    if (next === undefined) return
    syncPending()
    beginTurn(next)
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
    // SDK 0.3.307 has no interrupt receipt — the CLI ends the interrupted turn
    // with a success result carrying terminal_reason:'interrupt' (notes §2.2),
    // which the translator maps to turn.end{interrupted}.
    try {
      q.transport
        .sendControlRequest({
          subtype: 'interrupt',
          ...(cliSessionId ? { session_id: cliSessionId } : {}),
          reason: 'user interrupt',
        })
        .then(undefined, error => debug(`interrupt control request failed: ${error?.message}`))
    } catch (error) {
      debug(`interrupt failed: ${error?.message}`)
    }
  }

  function failNotice(detail) {
    return { type: 'notice', level: 'error', text: codebuddyText('cli-exited-notice', localeOf(host), { detail }) }
  }

  const pumpDone = (async () => {
    try {
      for await (const message of q.transport.messages()) {
        if (disposed) break
        frameCount += 1
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
    if (status === 'running' || translator.replayActive()) {
      // Running turn OR resume replay still in flight: queue (the replay
      // phase's settle releases the queue — notes in drainQueue).
      if (kind === 'now') {
        // 笔记语义：now = 打断当前回合立即投递。SDK 0.3.307 的 streamInput 没有
        // 优先级通道（claude 的 priority 'now' 在这里没有对应物），就近实现为：
        // interrupt 当前回合 + 本输入插队，回合收口后第一个运行。T4 收口完整语义。
        if (status === 'running') sendInterrupt()
        queue.unshift(item)
      } else {
        queue.push(item)
      }
      syncPending()
      return { accepted: true }
    }
    beginTurn(item)
    return { accepted: true }
  }

  async function cancel(cause = 'user') {
    if (disposed) return { stillQueued: [], outcome: 'failed' }
    const leaving = cause === 'interrupt' || cause === 'switch' || cause === 'dispose'
    const hadPending = queue.some(item => PENDING_PLACEMENTS.has(item.placement))
    if (leaving) {
      // interrupt 还要求丢弃队列输入（notes §2）：dropped:true 让 channel 把
      // 文本保留成 held row 供用户重发。
      for (const item of queue.splice(0)) debug(`dropped queued input ${item.clientMessageId} (cancel ${cause})`)
    }
    const running = status === 'running'
    if (running) sendInterrupt()
    syncPending(leaving && hadPending ? { dropped: true } : {})
    return {
      stillQueued: queue.map(item => item.clientMessageId),
      // confirmed 只有在队列状态确定时才诚实：空闲＝队列确定空；回 合在跑时
      // 没有回执机制 → unknown（绝不能被读成"队列空了"）。
      outcome: running ? 'unknown' : 'confirmed',
    }
  }

  let disposePromise = null
  async function dispose() {
    if (disposePromise) return disposePromise
    disposePromise = (async () => {
      disposed = true
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
