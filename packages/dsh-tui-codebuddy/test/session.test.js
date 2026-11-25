// Black-box tests for the session pipeline at the handler export surface —
// the seam agreed in docs/decisions.md §Spec: `backend.open()` drives the REAL
// @tencent-ai/agent-sdk against the fake CLI stub injected via
// CODEBUDDY_CODE_PATH (the SDK's first-priority CLI resolution, notes §7.1).
// Every test is headless: the stub replays the protocol per script and the
// assertions run over the emitted AgentEvent batches.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { backend } from '../backend.js'

const STUB_PATH = fileURLToPath(new URL('./fake-codebuddy-cli.js', import.meta.url))

// The CLI resolver caches, but every test points at the same stub file, so a
// module-level set-once is safe. The per-test variation travels through
// CB_FAKE_SCRIPT (fresh stub process per session).
process.env.CODEBUDDY_CODE_PATH = STUB_PATH

const SAVED_ENV = {
  CODEBUDDY_CODE_PATH: process.env.CODEBUDDY_CODE_PATH,
  CB_FAKE_SCRIPT: process.env.CB_FAKE_SCRIPT,
  CB_FAKE_MARKER_DIR: process.env.CB_FAKE_MARKER_DIR,
  CB_INTERRUPT_SETTLE_MS: process.env.CB_INTERRUPT_SETTLE_MS,
}
test.after(() => {
  // Assigning `undefined` into process.env would stringify to "undefined";
  // restore the pre-test state by deleting absent keys.
  for (const key of ['CODEBUDDY_CODE_PATH', 'CB_FAKE_SCRIPT', 'CB_FAKE_MARKER_DIR', 'CB_INTERRUPT_SETTLE_MS']) {
    if (SAVED_ENV[key] === undefined) delete process.env[key]
    else process.env[key] = SAVED_ENV[key]
  }
})

/** Minimal BackendHost stand-in: the session must feature-detect every
 *  optional member (notes §11). */
function host({ locale = 'zh' } = {}) {
  const debugLines = []
  return {
    cwd: process.cwd(),
    locale: () => locale,
    debug: message => debugLines.push(String(message)),
    warn: () => {},
    debugLines,
  }
}

/** Open a session against the stub with a fresh temp world (project cwd +
 *  marker dir + optional scenario file — one tree, one cleanup). */
async function openSession({ scenario, host: testHost } = {}) {
  const world = mkdtempSync(join(tmpdir(), 'codebuddy-world-'))
  const projectDir = join(world, 'project')
  const markerDir = join(world, 'markers')
  mkdirSync(projectDir)
  mkdirSync(markerDir)
  const scenarioPath = scenario === undefined ? undefined : join(world, 'scenario.json')
  if (scenarioPath === undefined) delete process.env.CB_FAKE_SCRIPT
  else {
    writeFileSync(scenarioPath, JSON.stringify(scenario))
    process.env.CB_FAKE_SCRIPT = scenarioPath
  }
  process.env.CB_FAKE_MARKER_DIR = markerDir
  const session = await backend.open({ kind: 'create', cwd: projectDir }, testHost ?? host())
  return { session, world, projectDir, markerDir, scenarioPath }
}

/** Tear a session down and clean the temp world. The stub process exits on
 *  stdin EOF but its exit can lag a few ms behind dispose() resolving — and
 *  Windows refuses to remove a directory that is still some process's cwd,
 *  so the removal retries briefly. */
async function closeSession(open, { dispose = true } = {}) {
  if (dispose) await open.session.dispose().catch(() => {})
  await rmWithRetry(open.world)
}

async function rmWithRetry(target, options = { recursive: true, force: true }) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      rmSync(target, options)
      return
    } catch (error) {
      if (error?.code !== 'EPERM' && error?.code !== 'ENOTEMPTY') throw error
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  rmSync(target, options) // last try — surface the error if it still fails
}

function collect(session) {
  const batches = []
  session.subscribe((events, meta) => batches.push({ events, meta }))
  return batches
}

const flatten = batches => batches.flatMap(batch => batch.events)

async function waitFor(batches, predicate, { timeoutMs = 5000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate(flatten(batches))) return
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  assert.fail(`timed out waiting for ${what}; events so far: ${JSON.stringify(flatten(batches).map(e => e.type))}`)
}

/** Stub-side evidence lives in marker files; wait for one to appear. */
async function waitForMarker(markerDir, prefix, { timeoutMs = 5000, what = 'marker' } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (readdirSync(markerDir).some(name => name.startsWith(prefix))) return
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  assert.fail(`timed out waiting for ${what} (${prefix}*) in ${markerDir}`)
}

// Predicates receive the flattened EVENT list (waitFor flattens the batches).
const readySeen = events => events.some(e => e.type === 'session.ready')
const turnEnded = events => events.filter(e => e.type === 'turn.end').length

/** A canonical assistant frame for stub scripts; the stub fills uuid/session_id. */
function assistantFrame(text) {
  return {
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      id: 'msg_scripted', type: 'message', role: 'assistant', model: 'stub-model',
      content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  }
}

test('open returns a real AgentSession: the four verbs + ref + cwd + empty history', async () => {
  const open = await openSession()
  try {
    const session = open.session
    assert.equal(typeof session.subscribe, 'function')
    assert.equal(typeof session.submit, 'function')
    assert.equal(typeof session.cancel, 'function')
    assert.equal(typeof session.dispose, 'function')
    assert.equal(typeof session.history, 'function')
    assert.equal(session.ref.backendId, 'codebuddy')
    assert.equal(typeof session.ref.sessionId, 'string')
    assert.ok(session.ref.sessionId.length > 0)
    assert.equal(session.cwd, open.projectDir)
    assert.deepEqual(await session.history(), [])
    // open() awaits the initialize handshake, but consuming the init frame is
    // the pump's first microtask — either state is legitimate here.
    assert.ok(['starting', 'idle'].includes(session.status), `status: ${session.status}`)
  } finally {
    await closeSession(open)
  }
})

test('submit drives the whole pipeline: ready → user → deltas → assistant message → turn end', async () => {
  const open = await openSession()
  try {
    const session = open.session
    const batches = collect(session)
    await waitFor(batches, readySeen, { what: 'session.ready' })

    const accepted = await session.submit({ text: 'hi', clientMessageId: 'u1' }, 'turn')
    assert.deepEqual(accepted, { accepted: true })
    await waitFor(batches, batches2 => turnEnded(batches2) >= 1, { what: 'turn.end' })

    const events = flatten(batches)
    const types = events.map(e => e.type)
    // Order: ready first, then the submit pair, the streaming attempt, the
    // canonical message, and the turn end.
    assert.equal(types[0], 'session.ready')
    const indexOf = type => types.indexOf(type)
    assert.ok(indexOf('user.message') < indexOf('turn.start'), 'user.message precedes turn.start')
    assert.ok(indexOf('turn.start') < indexOf('assistant.delta'), 'turn.start precedes deltas')
    assert.ok(indexOf('assistant.delta') < indexOf('assistant.attempt.end'), 'deltas precede attempt end')
    assert.ok(indexOf('assistant.attempt.end') < indexOf('assistant.message'), 'attempt end precedes message')
    assert.ok(indexOf('assistant.message') < indexOf('turn.end'), 'message precedes turn.end')

    // Shapes of the four event families this ticket must cover.
    const ready = events[0]
    assert.equal(ready.sessionId, session.ref.sessionId, 'init echoes the requested session id')
    assert.equal(ready.cwd, open.projectDir)
    assert.equal(ready.model, 'stub-model')
    const userMessage = events.find(e => e.type === 'user.message')
    assert.equal(userMessage.id, 'u1')
    assert.equal(userMessage.anchor, 'u1')
    assert.equal(userMessage.source, 'user')
    assert.equal(userMessage.text, 'hi')
    const turnStart = events.find(e => e.type === 'turn.start')
    assert.equal(turnStart.turn, 1)
    assert.equal(turnStart.origin, 'user')
    assert.equal(turnStart.userMessageId, 'u1')
    const deltas = events.filter(e => e.type === 'assistant.delta')
    assert.ok(deltas.length >= 2, 'the echo turn streams at least two deltas')
    assert.equal(deltas[0].attemptId, 'a1')
    assert.deepEqual(deltas.map(d => d.index), deltas.map((_, i) => i), 'delta indexes are sequential')
    assert.ok(deltas.every(d => d.delta.kind === 'text'))
    const joined = deltas.map(d => d.delta.text).join('')
    const message = events.find(e => e.type === 'assistant.message')
    assert.equal(joined, message.blocks[0].text, 'deltas concatenate to the canonical text')
    assert.equal(message.canonical, true)
    assert.equal(message.turn, 1)
    assert.equal(message.step, 1)
    assert.equal(message.attemptId, 'a1')
    const attemptStart = events.find(e => e.type === 'assistant.attempt.start')
    assert.equal(attemptStart.attemptId, 'a1')
    const turnEnd = events.find(e => e.type === 'turn.end')
    assert.deepEqual(turnEnd.reason, { kind: 'completed' })
    assert.deepEqual(turnEnd.usage, { input: 10, output: 5 })

    // Session status rode along: running at submit, idle at the end.
    const statuses = events.filter(e => e.type === 'session.status').map(e => e.status)
    assert.ok(statuses.includes('running') && statuses.includes('idle'), `statuses: ${statuses}`)

    // Identity map: seq contiguous across seq-carrying events.
    const seqs = events.filter(e => typeof e.seq === 'number').map(e => e.seq)
    assert.deepEqual(seqs, seqs.map((_, i) => i + 1), `seqs: ${seqs}`)

    // Meta: delta-only batches are frame-coalesced, the rest sync.
    for (const batch of batches) {
      const onlyDeltas = batch.events.length > 0 && batch.events.every(e => e.type === 'assistant.delta')
      assert.equal(batch.meta.wake, onlyDeltas ? 'frame' : 'sync')
      assert.equal(batch.meta.replay, false)
    }
  } finally {
    await closeSession(open)
  }
})

test('a second submit while running queues FIFO and runs after the first turn', async () => {
  const open = await openSession({
    // Turn 1 emits its message immediately and hangs before the result — a
    // deterministic window in which the second submit must queue.
    scenario: { turns: [{ frames: [assistantFrame('slow first')], resultDelayMs: 1500 }, {}] },
  })
  try {
    const session = open.session
    const batches = collect(session)
    await waitFor(batches, readySeen, { what: 'session.ready' })
    await session.submit({ text: 'first', clientMessageId: 'uA' }, 'turn')
    await waitFor(batches, evs => evs.some(e => e.type === 'assistant.message'), { what: 'first turn message' })

    const queued = await session.submit({ text: 'second', clientMessageId: 'uB' }, 'turn')
    assert.deepEqual(queued, { accepted: true })
    // No second turn may have started yet.
    assert.equal(flatten(batches).filter(e => e.type === 'turn.start').length, 1)
    assert.ok(!flatten(batches).some(e => e.type === 'pending.changed'), 'turn-placement queue items are not pending-listed')

    await waitFor(batches, batches2 => turnEnded(batches2) >= 2, { what: 'both turns' })
    const turns = flatten(batches).filter(e => e.type === 'turn.start').map(e => e.turn)
    assert.deepEqual(turns, [1, 2])
    const users = flatten(batches).filter(e => e.type === 'user.message').map(e => e.id)
    assert.deepEqual(users, ['uA', 'uB'], 'FIFO order preserved')
  } finally {
    await closeSession(open)
  }
})

test('unknown protocol frames and non-JSON stdout noise are ignored without crashing', async () => {
  const open = await openSession({
    scenario: {
      // Frames the SDK/CLI may emit that this bundle maps to nothing yet…
      afterInit: [
        { type: 'system', subtype: 'usage_update', _meta: { 'codebuddy.ai/turnUsage': {} } },
        { type: 'galaxy_brain', level: 11 },
        { type: 'file-history-snapshot', snapshot: { messageId: 'm1', trackedFileBackups: [] } },
      ],
    },
  })
  try {
    const session = open.session
    const batches = collect(session)
    await waitFor(batches, readySeen, { what: 'session.ready' })
    await session.submit({ text: 'still alive?', clientMessageId: 'u1' }, 'turn')
    await waitFor(batches, batches2 => turnEnded(batches2) >= 1, { what: 'turn.end' })
    const events = flatten(batches)
    assert.ok(!events.some(e => e.type === 'galaxy_brain'))
    assert.ok(!events.some(e => e.type === 'context.usage'), 'unmapped frames emit nothing')
    assert.ok(events.some(e => e.type === 'assistant.message'), 'session still converses after the noise')
  } finally {
    await closeSession(open)
  }
})

test('dispose aborts a running turn, releases the CLI process, and rejects further submits', async () => {
  const open = await openSession({
    scenario: { turns: [{ frames: [assistantFrame('slow')], resultDelayMs: 30_000 }] },
  })
  try {
    const session = open.session
    const batches = collect(session)
    await waitFor(batches, readySeen, { what: 'session.ready' })
    await session.submit({ text: 'long turn', clientMessageId: 'u1' }, 'turn')
    await waitFor(batches, evs => evs.some(e => e.type === 'assistant.message'), { what: 'turn in flight' })

    await session.dispose()
    assert.equal(session.status, 'disposed')

    // The abandoned turn synthesizes its end with the disposed cause.
    const events = flatten(batches)
    const turnEnd = events.find(e => e.type === 'turn.end')
    assert.deepEqual(turnEnd.reason, { kind: 'aborted', cause: 'disposed' })
    assert.ok(events.some(e => e.type === 'session.status' && e.status === 'disposed'))

    // Further submits are refused with a localized reason, not accepted.
    const refused = await session.submit({ text: 'too late', clientMessageId: 'u2' }, 'turn')
    assert.equal(refused.accepted, false)
    assert.ok(typeof refused.reason === 'string' && refused.reason.length > 0)

    // Explicit no-dangling-handle assertion 1: the stub saw stdin EOF and
    // exited by itself (no 8s backstop kill) — the exit marker file exists.
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !readdirSync(open.markerDir).some(name => name.startsWith('stub-exit-'))) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.ok(readdirSync(open.markerDir).some(name => name.startsWith('stub-exit-')), 'stub exited on EOF')

    // Explicit no-dangling-handle assertion 2: the SDK host process holds no
    // live child process handle anymore.
    assert.ok(!process.getActiveResourcesInfo().includes('ChildProcess'),
      `active resources: ${process.getActiveResourcesInfo().join(',')}`)

    // dispose is idempotent.
    await session.dispose()
  } finally {
    await closeSession(open)
  }
})

// ── slice 2: placement semantics + cancel + localized refusals ───────────────

const HANGING_TURN = { frames: [assistantFrame('hanging')], resultDelayMs: 30_000 }

test('steer and followup submitted while running queue up via pending.changed and run in arrival order', async () => {
  // Turn 1 ends on its own shortly after its message — the queued steer and
  // followup must then run in arrival order.
  const open = await openSession({
    scenario: { turns: [{ frames: [assistantFrame('slow first')], resultDelayMs: 400 }, {}, {}] },
  })
  try {
    const session = open.session
    const batches = collect(session)
    await waitFor(batches, readySeen, { what: 'session.ready' })
    await session.submit({ text: 'running', clientMessageId: 'uA' }, 'turn')
    await waitFor(batches, evs => evs.some(e => e.type === 'assistant.message'), { what: 'turn in flight' })

    await session.submit({ text: 'steer me', clientMessageId: 'uS' }, 'steer')
    await session.submit({ text: 'after that', clientMessageId: 'uF' }, 'followup')
    await waitFor(batches, evs => evs.some(e => e.type === 'pending.changed' && e.items.length === 2), { what: 'pending snapshot' })
    const snapshot = flatten(batches).find(e => e.type === 'pending.changed' && e.items.length === 2)
    assert.deepEqual(snapshot.items, [
      { id: 'uS', text: 'steer me', placement: 'steer' },
      { id: 'uF', text: 'after that', placement: 'followup' },
    ])

    await waitFor(batches, evs => turnEnded(evs) >= 3, { what: 'all three turns' })
    const users = flatten(batches).filter(e => e.type === 'user.message').map(e => e.id)
    assert.deepEqual(users, ['uA', 'uS', 'uF'], 'arrival order preserved across placements')
    // The queue drained: the final pending snapshot is empty.
    const lastPending = flatten(batches).filter(e => e.type === 'pending.changed').at(-1)
    assert.deepEqual(lastPending.items, [])
  } finally {
    await closeSession(open)
  }
})

test('cancel(interrupt) interrupts the running turn, drops queued inputs, and reports an unknown receipt', async () => {
  const open = await openSession({ scenario: { turns: [HANGING_TURN] } })
  try {
    const session = open.session
    const batches = collect(session)
    await waitFor(batches, readySeen, { what: 'session.ready' })
    await session.submit({ text: 'running', clientMessageId: 'uA' }, 'turn')
    await waitFor(batches, evs => evs.some(e => e.type === 'assistant.message'), { what: 'turn in flight' })
    await session.submit({ text: 'queued', clientMessageId: 'uS' }, 'steer')

    const receipt = await session.cancel('interrupt')
    // No interrupt receipt exists in SDK 0.3.307 — the outcome must be honest.
    assert.deepEqual(receipt, { stillQueued: [], outcome: 'unknown' })

    // The interrupt signal really reached the CLI process — stub-side marker
    // evidence (acceptance: the interrupt arrives at the CLI, not just in our
    // own state).
    await waitForMarker(open.markerDir, 'stub-interrupt-', { what: 'interrupt marker' })

    // The queued input is dropped with dropped:true (channel keeps it as a
    // held row for the user to resend).
    await waitFor(batches, evs => evs.some(e => e.type === 'pending.changed' && e.dropped === true), { what: 'dropped pending' })

    // The CLI ends the interrupted turn with a success result carrying
    // terminal_reason — mapped to turn.end{interrupted}.
    await waitFor(batches, evs => evs.some(e => e.type === 'turn.end'), { what: 'interrupted turn end' })
    const turnEnd = flatten(batches).find(e => e.type === 'turn.end')
    assert.deepEqual(turnEnd.reason, { kind: 'interrupted' })

    // Nothing queued → no next turn starts.
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.equal(flatten(batches).filter(e => e.type === 'turn.start').length, 1, 'no turn 2 after interrupt')
  } finally {
    await closeSession(open)
  }
})

test('cancel(user) keeps queued inputs: they run after the interrupted turn ends', async () => {
  const open = await openSession({ scenario: { turns: [HANGING_TURN, {}] } })
  try {
    const session = open.session
    const batches = collect(session)
    await waitFor(batches, readySeen, { what: 'session.ready' })
    await session.submit({ text: 'running', clientMessageId: 'uA' }, 'turn')
    await waitFor(batches, evs => evs.some(e => e.type === 'assistant.message'), { what: 'turn in flight' })
    await session.submit({ text: 'kept', clientMessageId: 'uB' }, 'turn')

    const receipt = await session.cancel('user')
    assert.deepEqual(receipt, { stillQueued: ['uB'], outcome: 'unknown' })

    await waitFor(batches, evs => turnEnded(evs) >= 2, { what: 'both turns' })
    const reasons = flatten(batches).filter(e => e.type === 'turn.end').map(e => e.reason.kind)
    assert.deepEqual(reasons, ['interrupted', 'completed'])
    const users = flatten(batches).filter(e => e.type === 'user.message').map(e => e.id)
    assert.deepEqual(users, ['uA', 'uB'], 'the kept input runs next')
  } finally {
    await closeSession(open)
  }
})

test('cancel at idle reports a confirmed receipt — a true snapshot of the live queue', async () => {
  const open = await openSession()
  try {
    const session = open.session
    const batches = collect(session)
    await waitFor(batches, readySeen, { what: 'session.ready' })
    await session.submit({ text: 'short', clientMessageId: 'u1' }, 'turn')
    await waitFor(batches, batches2 => turnEnded(batches2) >= 1, { what: 'turn end' })

    // Nothing is in flight, so the local queue IS the live queue: confirmed
    // is a real snapshot the channel may read as "the queue is now empty".
    const receipt = await session.cancel('interrupt')
    assert.deepEqual(receipt, { stillQueued: [], outcome: 'confirmed' })
  } finally {
    await closeSession(open)
  }
})

test('cancel on a disposed session reports failed', async () => {
  const open = await openSession()
  try {
    await open.session.dispose()
    const receipt = await open.session.cancel('user')
    assert.deepEqual(receipt, { stillQueued: [], outcome: 'failed' })
  } finally {
    await closeSession(open)
  }
})

test('cancel on a dead CLI reports failed and the death was announced', async () => {
  const open = await openSession({ scenario: { exitAfterFirstUser: true } })
  try {
    const session = open.session
    const batches = collect(session)
    await waitFor(batches, readySeen, { what: 'session.ready' })
    await session.submit({ text: 'running', clientMessageId: 'uA' }, 'turn')
    // The stub dies mid-turn without a result; the pump announces the loss.
    await waitFor(batches, evs => evs.some(e => e.type === 'notice' && e.level === 'error'), { what: 'cli-exited notice' })
    await waitForMarker(open.markerDir, 'stub-exit-', { what: 'stub exit marker' })

    // There is no CLI left to cancel — the receipt must say failed, never
    // confirmed (a failed cancel must not read as "the queue is empty").
    const receipt = await session.cancel('interrupt')
    assert.deepEqual(receipt, { stillQueued: [], outcome: 'failed' })
  } finally {
    await closeSession(open)
  }
})

test('now placement interrupts the running turn and jumps the queue', async () => {
  const open = await openSession({ scenario: { turns: [HANGING_TURN, {}] } })
  try {
    const session = open.session
    const batches = collect(session)
    await waitFor(batches, readySeen, { what: 'session.ready' })
    await session.submit({ text: 'running', clientMessageId: 'uA' }, 'turn')
    await waitFor(batches, evs => evs.some(e => e.type === 'assistant.message'), { what: 'turn in flight' })

    const accepted = await session.submit({ text: 'urgent', clientMessageId: 'uN' }, 'now')
    assert.deepEqual(accepted, { accepted: true })

    await waitFor(batches, evs => turnEnded(evs) >= 2, { what: 'both turns' })
    const turnStarts = flatten(batches).filter(e => e.type === 'turn.start')
    assert.deepEqual(turnStarts.map(e => e.userMessageId), ['uA', 'uN'], 'the urgent input runs right after the interrupt')
    assert.deepEqual(flatten(batches).filter(e => e.type === 'turn.end').map(e => e.reason.kind), ['interrupted', 'completed'])
  } finally {
    await closeSession(open)
  }
})

test('an interrupt the CLI never answers force-settles the turn; the session keeps going (bilingual notice)', async () => {
  for (const locale of ['zh', 'en']) {
    // Shorten the settle window for the test; production default is 15s.
    process.env.CB_INTERRUPT_SETTLE_MS = '400'
    const open = await openSession({
      host: host({ locale }),
      scenario: {
        // "CLI 超时不回 result" line: the interrupt is acked but no result
        // ever follows.
        turns: [{ frames: [assistantFrame('never ends')], resultDelayMs: 60_000, interruptResult: 'none' }, {}],
      },
    })
    try {
      const session = open.session
      const batches = collect(session)
      await waitFor(batches, readySeen, { what: 'session.ready' })
      await session.submit({ text: 'running', clientMessageId: 'uA' }, 'turn')
      await waitFor(batches, evs => evs.some(e => e.type === 'assistant.message'), { what: 'turn in flight' })
      await session.submit({ text: 'queued', clientMessageId: 'uS' }, 'steer')

      const receipt = await session.cancel('user')
      assert.deepEqual(receipt, { stillQueued: ['uS'], outcome: 'unknown' })
      await waitForMarker(open.markerDir, 'stub-interrupt-', { what: 'interrupt marker' })

      // Backstop: no result within the settle window → the turn is closed
      // locally with a warning notice — never a permanent hang.
      await waitFor(batches, evs => evs.some(e => e.type === 'turn.end' && e.reason.kind === 'aborted'), { what: 'forced turn end' })
      const needle = locale === 'en' ? 'force-settled' : '强制收口'
      const notice = flatten(batches).find(e => e.type === 'notice' && e.text.includes(needle))
      assert.ok(notice, `${locale} notice explains the force-settle`)
      assert.equal(notice.level, 'warning')

      // The session keeps going: the kept steer input runs next and completes.
      await waitFor(batches, evs => turnEnded(evs) >= 2, { what: 'queued input after backstop' })
      const users = flatten(batches).filter(e => e.type === 'user.message').map(e => e.id)
      assert.deepEqual(users, ['uA', 'uS'])
      assert.equal(flatten(batches).filter(e => e.type === 'turn.end').at(-1).reason.kind, 'completed')
    } finally {
      await closeSession(open)
    }
  }
})

test('now jumps ahead of already-queued steer and followup inputs', async () => {
  const open = await openSession({ scenario: { turns: [HANGING_TURN, {}, {}, {}] } })
  try {
    const session = open.session
    const batches = collect(session)
    await waitFor(batches, readySeen, { what: 'session.ready' })
    await session.submit({ text: 'running', clientMessageId: 'uA' }, 'turn')
    await waitFor(batches, evs => evs.some(e => e.type === 'assistant.message'), { what: 'turn in flight' })
    await session.submit({ text: 'steer me', clientMessageId: 'uS' }, 'steer')
    await session.submit({ text: 'after that', clientMessageId: 'uF' }, 'followup')

    const accepted = await session.submit({ text: 'urgent', clientMessageId: 'uN' }, 'now')
    assert.deepEqual(accepted, { accepted: true })

    await waitFor(batches, evs => turnEnded(evs) >= 4, { what: 'all four turns' })
    const users = flatten(batches).filter(e => e.type === 'user.message').map(e => e.id)
    assert.deepEqual(users, ['uA', 'uN', 'uS', 'uF'], 'the urgent input runs first, queued inputs keep their order')
    const reasons = flatten(batches).filter(e => e.type === 'turn.end').map(e => e.reason.kind)
    assert.deepEqual(reasons, ['interrupted', 'completed', 'completed', 'completed'])
  } finally {
    await closeSession(open)
  }
})

test('refusal reasons are bilingual: the host locale picks the wording', async () => {
  for (const locale of ['zh', 'en']) {
    const open = await openSession({ host: host({ locale }) })
    try {
      await open.session.dispose()
      const refused = await open.session.submit({ text: 'late', clientMessageId: 'u1' }, 'turn')
      assert.equal(refused.accepted, false)
      assert.ok(typeof refused.reason === 'string' && refused.reason.length > 0)
      assert.ok(
        locale === 'en' ? refused.reason.includes('disposed') : refused.reason.includes('已结束'),
        `${locale} reason: ${refused.reason}`,
      )
    } finally {
      await closeSession(open)
    }
  }
})
