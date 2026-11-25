// Black-box tests for session resume (ticket T5 / issue #6) at the agreed
// seam: `backend.open()` drives the REAL @tencent-ai/agent-sdk against the
// fake CLI stub (CODEBUDDY_CODE_PATH), the stub scripting the resume replay.
// Covers: lastSession memory recording, the one-shot history() replay seed
// with native re-anchors and continuous numbering into the live stream,
// deferred submits during replay, and loud bilingual failures.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { backend, launch } from '../backend.js'
import { createCodebuddyPrefs } from '../prefs.js'

const STUB_PATH = fileURLToPath(new URL('./fake-codebuddy-cli.js', import.meta.url))

process.env.CODEBUDDY_CODE_PATH = STUB_PATH

const SAVED_ENV = {
  CODEBUDDY_CODE_PATH: process.env.CODEBUDDY_CODE_PATH,
  CB_FAKE_SCRIPT: process.env.CB_FAKE_SCRIPT,
  CB_FAKE_MARKER_DIR: process.env.CB_FAKE_MARKER_DIR,
}
test.after(() => {
  if (SAVED_ENV.CODEBUDDY_CODE_PATH === undefined) delete process.env.CODEBUDDY_CODE_PATH
  else process.env.CODEBUDDY_CODE_PATH = SAVED_ENV.CODEBUDDY_CODE_PATH
  if (SAVED_ENV.CB_FAKE_SCRIPT === undefined) delete process.env.CB_FAKE_SCRIPT
  else process.env.CB_FAKE_SCRIPT = SAVED_ENV.CB_FAKE_SCRIPT
  if (SAVED_ENV.CB_FAKE_MARKER_DIR === undefined) delete process.env.CB_FAKE_MARKER_DIR
  else process.env.CB_FAKE_MARKER_DIR = SAVED_ENV.CB_FAKE_MARKER_DIR
})

function host({ locale = 'zh', dataDir } = {}) {
  const debugLines = []
  return {
    cwd: process.cwd(),
    ...(dataDir !== undefined ? { dataDir } : {}),
    locale: () => locale,
    debug: message => debugLines.push(String(message)),
    warn: () => {},
    debugLines,
  }
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
  rmSync(target, options)
}

/** Open a session against the stub with a fresh temp world. */
async function openSession({ target, scenario, testHost } = {}) {
  const world = mkdtempSync(join(tmpdir(), 'codebuddy-resume-'))
  const projectDir = join(world, 'project')
  const markerDir = join(world, 'markers')
  mkdirSync(projectDir)
  mkdirSync(markerDir)
  if (scenario === undefined) delete process.env.CB_FAKE_SCRIPT
  else {
    writeFileSync(join(world, 'scenario.json'), JSON.stringify(scenario))
    process.env.CB_FAKE_SCRIPT = join(world, 'scenario.json')
  }
  process.env.CB_FAKE_MARKER_DIR = markerDir
  const session = await backend.open(target ?? { kind: 'create', cwd: projectDir }, testHost ?? host())
  return { session, world, projectDir, markerDir }
}

async function closeSession(open, { dispose = true } = {}) {
  if (dispose) await open.session.dispose().catch(() => {})
  await rmWithRetry(open.world)
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

const readySeen = events => events.some(e => e.type === 'session.ready')

// ── lastSession recording ────────────────────────────────────────────────────

test('opening a create session records it as this backend\'s lastSession (file store)', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codebuddy-last-'))
  try {
    const testHost = host({ dataDir })
    const open = await openSession({ testHost })
    try {
      const batches = collect(open.session)
      await waitFor(batches, readySeen, { what: 'session.ready' })
      // The launcher's bare --resume would read the same store.
      assert.equal(launch.sessionPrefs(testHost).lastSession(), open.session.ref.sessionId)
      const onDisk = JSON.parse(readFileSync(join(dataDir, 'last-session.json'), 'utf8'))
      assert.equal(onDisk.lastSessionId, open.session.ref.sessionId)
    } finally {
      await closeSession(open)
    }
  } finally {
    await rmWithRetry(dataDir)
  }
})

test('opening a resume session re-points lastSession at the resumed id (memory store)', async () => {
  const testHost = host()
  const prefs = createCodebuddyPrefs(testHost)
  prefs.setLastSession('older-session')
  const open = await openSession({
    target: { kind: 'resume', sessionId: 'cb-resume-prefs' },
    scenario: { resume: { sessionId: 'cb-resume-prefs', history: [] } },
    testHost,
  })
  try {
    const batches = collect(open.session)
    await waitFor(batches, readySeen, { what: 'session.ready' })
    assert.equal(prefs.lastSession(), 'cb-resume-prefs', 'the resumed id becomes the most recent')
  } finally {
    await closeSession(open)
  }
})

// ── the replay seed: sequence, re-anchoring, one-shot handoff ────────────────

const TOOL_HISTORY = [
  { user: 'first question', assistant: [{ type: 'text', text: 'first answer' }] },
  {
    user: 'run it',
    assistant: [{ type: 'tool_use', id: 'toolu_h1', name: 'Bash', input: { command: 'echo hi' } }],
    toolResult: { toolUseId: 'toolu_h1', content: 'hi' },
    assistant2: [{ type: 'text', text: 'done with tool' }],
  },
]

/** The exact event sequence two fully-closed historical turns must produce:
 *  user → turn → step/attempt/message → end, and the tool turn's second step
 *  after the tool result. Same vocabulary, same shape as live. */
const SEED_TYPE_SEQUENCE = [
  'user.message', 'turn.start',
  'step.start', 'assistant.attempt.start', 'assistant.attempt.end', 'step.end', 'assistant.message', 'turn.end',
  'user.message', 'turn.start',
  'step.start', 'assistant.attempt.start', 'assistant.attempt.end', 'step.end', 'tool.call', 'assistant.message',
  'tool.result',
  'step.start', 'assistant.attempt.start', 'assistant.attempt.end', 'step.end', 'assistant.message',
  'turn.end',
]

test('resume replays history as a one-shot seed with native anchors and the live stream continues the numbering', async () => {
  const open = await openSession({
    target: { kind: 'resume', sessionId: 'cb-resume-1' },
    scenario: { resume: { sessionId: 'cb-resume-1', history: TOOL_HISTORY } },
  })
  try {
    const session = open.session
    assert.equal(session.ref.sessionId, 'cb-resume-1')
    const batches = collect(session) // subscribed BEFORE history()
    await waitFor(batches, readySeen, { what: 'session.ready' })

    const seed = await session.history()
    assert.ok(seed.length > 0, 'the seed is non-empty')
    assert.deepEqual(seed.map(e => e.type), SEED_TYPE_SEQUENCE, 'replay event sequence')
    assert.ok(!seed.some(e => e.type === 'session.ready'), 'session.ready stays on the live stream')
    // One-shot handoff (notes §2): afterwards the seed is gone.
    assert.deepEqual(await session.history(), [], 'history() hands the seed exactly once')

    // Re-anchoring: every replayed family anchors on the CLI's own uuid —
    // uniformly, including the user rows (the T2 clientMessageId anchors end
    // at replay).
    for (const event of seed) {
      if (['user.message', 'assistant.message', 'tool.call'].includes(event.type)) {
        assert.match(event.anchor, /^u-\d+$/, `${event.type} anchor is the CLI uuid`)
        if (event.type === 'user.message') assert.equal(event.id, event.anchor, 'user row id follows the native anchor')
      }
    }
    assert.ok(!seed.some(e => e.anchor === 'u-live-1'), 'no submit-time anchors leaked into the seed')

    // Numbering: the seed is contiguous and the live stream continues without
    // skipping.
    const seedSeqs = seed.filter(e => typeof e.seq === 'number').map(e => e.seq)
    assert.deepEqual(seedSeqs, seedSeqs.map((_, i) => i + 1), `seed seqs: ${seedSeqs}`)
    assert.deepEqual(seed.filter(e => e.type === 'turn.start').map(e => e.turn), [1, 2])
    const lastSeedSeq = seedSeqs.at(-1)

    // 先画历史再接 live: subscribed batches carry NO seed events.
    assert.equal(flatten(batches).filter(e => e.type === 'user.message').length, 0, 'no seed rows leaked to subscribe')

    // Live continuation.
    await session.submit({ text: 'live question', clientMessageId: 'u-live-1' }, 'turn')
    await waitFor(batches, evs => evs.some(e => e.type === 'turn.end'), { what: 'live turn end' })
    const live = flatten(batches)
    const liveUser = live.find(e => e.type === 'user.message')
    assert.equal(liveUser.id, 'u-live-1')
    assert.equal(liveUser.anchor, 'u-live-1', 'live user rows keep the submit-time anchor (T2 semantics)')
    assert.equal(liveUser.seq, lastSeedSeq + 1, 'live seq continues the seed without skipping')
    const liveStart = live.find(e => e.type === 'turn.start')
    assert.equal(liveStart.turn, 3, 'live turn number continues the replay turns')
    const liveSeqs = live.filter(e => typeof e.seq === 'number').map(e => e.seq)
    assert.deepEqual([...seedSeqs, ...liveSeqs], [...seedSeqs, ...liveSeqs].map((_, i) => i + 1), 'seed → live seqs are one contiguous run')
    const liveEnd = live.filter(e => e.type === 'turn.end').at(-1)
    assert.deepEqual(liveEnd.reason, { kind: 'completed' })
    // Batches stay live-flagged; the seed never rode subscribe.
    assert.ok(batches.every(batch => batch.meta.replay === false))
  } finally {
    await closeSession(open)
  }
})

test('a submit issued during the replay is deferred: it runs only after the seed handoff, numbered continuously', async () => {
  const open = await openSession({
    target: { kind: 'resume', sessionId: 'cb-resume-slow' },
    scenario: {
      resume: {
        sessionId: 'cb-resume-slow',
        historyDelayMs: 250, // pace the history so the submit lands mid-replay
        history: [
          { user: 'h1', assistant: [{ type: 'text', text: 'a1' }] },
          { user: 'h2', assistant: [{ type: 'text', text: 'a2' }] },
        ],
      },
    },
  })
  try {
    const session = open.session
    const batches = collect(session)
    await waitFor(batches, readySeen, { what: 'session.ready' })

    // Submit BEFORE history(): the replay is still streaming. The submit must
    // be accepted but NOT start a turn — its stdin write would otherwise
    // interleave with the CLI's replay output.
    const accepted = await session.submit({ text: 'early bird', clientMessageId: 'u-early' }, 'turn')
    assert.deepEqual(accepted, { accepted: true })
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(flatten(batches).filter(e => e.type === 'turn.start').length, 0, 'no live turn starts during the replay')

    const seed = await session.history()
    const seedSeqs = seed.filter(e => typeof e.seq === 'number').map(e => e.seq)
    assert.deepEqual(seedSeqs, seedSeqs.map((_, i) => i + 1))
    assert.equal(seed.filter(e => e.type === 'turn.start').length, 2)

    // The deferred input starts right after the handoff, continuing the seed.
    await waitFor(batches, evs => evs.some(e => e.type === 'turn.end'), { what: 'deferred live turn' })
    const live = flatten(batches)
    const liveStart = live.find(e => e.type === 'turn.start')
    assert.equal(liveStart.turn, 3, 'the deferred input opens turn 3 after two replay turns')
    assert.equal(liveStart.userMessageId, 'u-early')
    const liveUser = live.find(e => e.type === 'user.message')
    assert.equal(liveUser.seq, seedSeqs.at(-1) + 1, 'no seq gap between seed and the deferred turn')
    // The deferred turn ran to completion (its CLI answer and end are in the
    // live stream — seed turn.ends never ride subscribe, so exactly one
    // turn.end is expected here).
    assert.equal(live.filter(e => e.type === 'turn.end').length, 1)
    assert.deepEqual(live.filter(e => e.type === 'turn.end').at(-1).reason, { kind: 'completed' })
    assert.ok(live.some(e => e.type === 'assistant.message'), 'the deferred turn got its CLI answer')
  } finally {
    await closeSession(open)
  }
})

// ── loud failures: no fallback, no silent new session ────────────────────────

test('resuming an unknown session fails loudly: bilingual error, non-zero CLI exit, no fallback', async () => {
  for (const locale of ['zh', 'en']) {
    const world = mkdtempSync(join(tmpdir(), 'codebuddy-fail-'))
    const projectDir = join(world, 'project')
    const markerDir = join(world, 'markers')
    mkdirSync(projectDir)
    mkdirSync(markerDir)
    writeFileSync(join(world, 'scenario.json'), JSON.stringify({ resume: { unknownSession: true } }))
    process.env.CB_FAKE_SCRIPT = join(world, 'scenario.json')
    process.env.CB_FAKE_MARKER_DIR = markerDir
    try {
      const error = await backend.open({ kind: 'resume', sessionId: 'cb-unknown' }, host({ locale })).then(
        () => null,
        e => e,
      )
      assert.ok(error instanceof Error, 'open() rejects — there is no session object to fall back to')
      const prefix = locale === 'en' ? /resume failed/ : /会话恢复失败/
      assert.match(error.message, prefix, `${locale} wording: ${error.message}`)
      assert.ok(error.message.length > 40, `the real cause rides in the detail: ${error.message}`)
      assert.match(error.message, /exit|not found|stderr/, `the CLI-side cause is preserved: ${error.message}`)

      // Non-zero exit evidence: the stub writes its exit code into the marker.
      const deadline = Date.now() + 5000
      let exitCode = null
      while (Date.now() < deadline && exitCode === null) {
        const marker = readdirSync(markerDir).find(name => name.startsWith('stub-exit-'))
        if (marker !== undefined) exitCode = readFileSync(join(markerDir, marker), 'utf8')
        else await new Promise(resolve => setTimeout(resolve, 25))
      }
      assert.equal(exitCode, '1', 'the CLI process exited non-zero on the unknown session')

      // No dangling CLI process handle is left behind.
      const settleDeadline = Date.now() + 2000
      while (Date.now() < settleDeadline && process.getActiveResourcesInfo().includes('ChildProcess')) {
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      assert.ok(!process.getActiveResourcesInfo().includes('ChildProcess'),
        `active resources: ${process.getActiveResourcesInfo().join(',')}`)
    } finally {
      delete process.env.CB_FAKE_SCRIPT
      await rmWithRetry(world)
    }
  }
})

test('resuming the same id twice in one process fails loudly (SDK session lock); the first session is unharmed', async () => {
  const scenario = { resume: { sessionId: 'cb-resume-lock', history: [{ user: 'kept', assistant: [{ type: 'text', text: 'seed' }] }] } }
  const openA = await openSession({ target: { kind: 'resume', sessionId: 'cb-resume-lock' }, scenario })
  try {
    const batchesA = collect(openA.session)
    await waitFor(batchesA, readySeen, { what: 'session A ready' })

    // Session B: same id, fresh stub process, same host process → the SDK's
    // process-level session lock for `--resume` must reject loudly.
    const error = await backend.open({ kind: 'resume', sessionId: 'cb-resume-lock' }, host()).then(
      () => null,
      e => e,
    )
    assert.ok(error instanceof Error, 'the second open rejects')
    assert.match(error.message, /会话恢复失败/, `bilingual wrap: ${error.message}`)
    assert.match(error.message, /already in use/, `the lock cause rides along: ${error.message}`)

    // Session A is unaffected: seed handoff and a live turn still work.
    const seed = await openA.session.history()
    assert.equal(seed.filter(e => e.type === 'user.message').length, 1)
    await openA.session.submit({ text: 'still here', clientMessageId: 'u-a' }, 'turn')
    await waitFor(batchesA, evs => evs.some(e => e.type === 'turn.end'), { what: 'session A live turn' })
    assert.equal(flatten(batchesA).find(e => e.type === 'user.message').id, 'u-a')
  } finally {
    await closeSession(openA)
  }
})

test('a resume without a usable session id is refused up front, in the host locale', async () => {
  for (const [target, locale, pattern] of [
    [{ kind: 'resume', sessionId: '' }, 'zh', /需要有效的会话 id/],
    [{ kind: 'resume', sessionId: '   ' }, 'en', /valid session id/],
    [{ kind: 'resume' }, 'zh', /需要有效的会话 id/],
    [{ kind: 'nonsense' }, 'zh', /kind "create" or "resume"/],
  ]) {
    const error = await backend.open(target, host({ locale })).then(() => null, e => e)
    assert.ok(error instanceof Error, `open(${JSON.stringify(target)}) rejects`)
    assert.match(error.message, pattern, `${JSON.stringify(target)} (${locale}): ${error.message}`)
  }
})

// ── translator-level replay units (no process): the settle edge ──────────────

import { createCodebuddyTranslator } from '../translator.js'

const replayTranslator = () => createCodebuddyTranslator({ cwd: 'x', now: () => 1, replay: true })

const replayUserFrame = (uuid, text) => ({
  type: 'user', uuid, session_id: 's', parent_tool_use_id: null,
  message: { role: 'user', content: text },
})
const replayAssistantFrame = uuid => ({
  type: 'assistant', uuid, session_id: 's', parent_tool_use_id: null,
  message: { id: `m-${uuid}`, type: 'message', role: 'assistant', model: 'stub-model',
    content: [{ type: 'text', text: 'answer' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 } },
})

test('settleReplay force-closes a dangling replayed turn and live numbering continues cleanly', () => {
  const t = replayTranslator()
  t.translate({ type: 'system', subtype: 'init', session_id: 's', model: 'm', cwd: 'x', tools: [] })
  // A historical turn that never got its result (a transcript truncated by a
  // crash): the replay phase is stuck with an open turn.
  t.translate(replayUserFrame('u-1', 'dangling question'))
  t.translate(replayAssistantFrame('u-2'))
  assert.equal(t.replayTurnOpen(), true, 'the truncated turn is still open')
  assert.equal(t.replayActive(), true)

  const settled = t.settleReplay()
  // The assistant frame already committed (and closed) its own attempt — the
  // settle only owes the missing turn end.
  assert.deepEqual(settled.map(e => e.type), ['turn.end'])
  assert.deepEqual(settled.at(-1), { type: 'turn.end', turn: 1, reason: { kind: 'interrupted' }, time: 1 },
    'the dangling turn ends interrupted so the channel sees a closed turn')
  assert.equal(t.replayActive(), false, 'the phase ends')
  assert.deepEqual(t.settleReplay(), [], 'settle is idempotent')

  // Live continuation after the forced settle: next submit opens turn 2.
  const live = t.userSubmitted({ text: 'next', clientMessageId: 'u-live' })
  assert.equal(live.find(e => e.type === 'turn.start').turn, 2, 'live turn continues the replay numbering')
  assert.equal(live.find(e => e.type === 'user.message').seq, 3, 'seq continues without skipping')
})

test('settleReplay on an already-quiet replay flips to live without inventing events', () => {
  const t = replayTranslator()
  t.translate({ type: 'system', subtype: 'init', session_id: 's', model: 'm', cwd: 'x', tools: [] })
  t.translate(replayUserFrame('u-1', 'q'))
  t.translate(replayAssistantFrame('u-2'))
  t.translate({ type: 'result', subtype: 'success', uuid: 'u-3', session_id: 's', duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1, result: 'q', total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 5 }, permission_denials: [] })
  assert.equal(t.replayTurnOpen(), false)
  assert.deepEqual(t.settleReplay(), [], 'no dangling turn → no synthesized events')
  assert.equal(t.replayActive(), false)
  // settle is a no-op once live, and a non-replay translator never reports active.
  assert.deepEqual(createCodebuddyTranslator({ cwd: 'x' }).settleReplay(), [])
  assert.equal(createCodebuddyTranslator({ cwd: 'x' }).replayActive(), false)
})

test('live mode stays inert toward text user frames (no accidental double rows)', () => {
  const t = createCodebuddyTranslator({ cwd: 'x', now: () => 1 })
  t.translate({ type: 'system', subtype: 'init', session_id: 's', model: 'm', cwd: 'x', tools: [] })
  const submitted = t.userSubmitted({ text: 'hi', clientMessageId: 'u1' })
  const echo = t.translate(replayUserFrame('u-9', 'should be ignored'))
  assert.deepEqual(echo, [], 'a live-mode text user frame produces nothing')
  const audit = []
  audit.push(...submitted, ...echo)
  t.translate(replayAssistantFrame('u-10'))
  t.translate({ type: 'result', subtype: 'success', uuid: 'u-11', session_id: 's', duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1, result: 'x', total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 5 }, permission_denials: [] })
  assert.equal(audit.length, 2, 'the live turn keeps its own submit pair untouched')
})
