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
import { createCodebuddyPermissionBridge } from './permissions.js'
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
  const translator = createCodebuddyTranslator({
    cwd,
    now: Date.now,
    debug,
    // The card tail's dropped-lines marker is user-visible text — live locale.
    text: (key, params) => codebuddyText(key, localeOf(host), params),
  })

  // The approval bridge (ticket T3): prompts park here and surface as
  // permission.request / permission.settled; the answers become the
  // PermissionResult the CLI expects. deliver/emit is hoisted, so the bridge
  // can be built before the query that receives canUseTool.
  const bridge = createCodebuddyPermissionBridge({
    cwd,
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
  // filesystem settings); our session id up front so ref.sessionId is known at
  // open time and the init frame echoes it back. canUseTool is the approval
  // bridge — without it the SDK auto-denies every can_use_tool request.
  const q = query({
    options: {
      cwd,
      sessionId: sessionKey,
      permissionMode: 'default',
      includePartialMessages: true,
      canUseTool: bridge.canUseTool,
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
  let turnActive = false // a turn is open (drives the requires-action return)
  const listeners = new Set()
  let backlog = [] // batches emitted before any subscriber
  const queue = [] // {clientMessageId, text, blocks, placement}
  const inbox = createInbox()

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
    turnActive = true
    deliver(events) // user.message + turn.start
    setStatus('running')
    // Write stdin AFTER the events are out so the channel sees the submit pair
    // first no matter how fast the CLI answers.
    inbox.push(userMessageFrame(item))
  }

  /** A turn just ended: back to idle, then run the next queued input. */
  function drainQueue() {
    if (disposed) return
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
          deliver([{ type: 'notice', level: 'error', text: codebuddyText('internal-error-notice', localeOf(host), { detail }) }])
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
        // 笔记语义：now = 打断当前回合立即投递。SDK 0.3.307 的 streamInput 没有
        // 优先级通道（claude 的 priority 'now' 在这里没有对应物），就近实现为：
        // interrupt 当前回合 + 本输入插队，回合收口后第一个运行。T4 收口完整语义。
        sendInterrupt()
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
      // 离开即撤回挂起审批（T3 面板不悬挂）：SDK 0.3.307 的 abort 信号不会因
      // 这条自造 interrupt 触发，桥自己收口， settled 事件先进 channel。
      bridge.settleAll()
    }
    const running = status === 'running' || status === 'requires-action'
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
    // 每个成员缺席＝明确"不支持"（notes §3）；permissions 是 T3 的审批能力：
    // respond 把面板决策送回 CLI，pending 列出仍挂起的请求（重开面板用）。
    capabilities: {
      permissions: {
        respond: bridge.respond,
        pending: () => bridge.pendingViews(),
      },
    },
    history,
    subscribe,
    submit,
    cancel,
    dispose,
  }
}
