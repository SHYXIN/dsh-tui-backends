// Black-box tests for the models capability (ticket T6) at the handler
// export surface — the REAL @tencent-ai/agent-sdk driven against the fake CLI
// stub (CODEBUDDY_CODE_PATH). The seam is `session.capabilities.models`
// (host-surface notes §3: list/current/set), and the SDK evidence travels in
// stub marker files: the initialize response's model list, the set_model
// control request that reached the CLI, and the argv of the NEXT session's
// CLI process (--model persistence).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { backend } from '../backend.js'

const STUB_PATH = fileURLToPath(new URL('./fake-codebuddy-cli.js', import.meta.url))
process.env.CODEBUDDY_CODE_PATH = STUB_PATH

const SAVED_ENV = {
  CODEBUDDY_CODE_PATH: process.env.CODEBUDDY_CODE_PATH,
  CB_FAKE_SCRIPT: process.env.CB_FAKE_SCRIPT,
  CB_FAKE_MARKER_DIR: process.env.CB_FAKE_MARKER_DIR,
}
test.after(() => {
  for (const key of ['CODEBUDDY_CODE_PATH', 'CB_FAKE_SCRIPT', 'CB_FAKE_MARKER_DIR']) {
    if (SAVED_ENV[key] === undefined) delete process.env[key]
    else process.env[key] = SAVED_ENV[key]
  }
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

async function openSession({ scenario, testHost } = {}) {
  const world = mkdtempSync(join(tmpdir(), 'codebuddy-models-'))
  const projectDir = join(world, 'project')
  const markerDir = join(world, 'markers')
  mkdirSync(projectDir)
  mkdirSync(markerDir)
  if (scenario === undefined) delete process.env.CB_FAKE_SCRIPT
  else {
    const scenarioPath = join(world, 'scenario.json')
    writeFileSync(scenarioPath, JSON.stringify(scenario))
    process.env.CB_FAKE_SCRIPT = scenarioPath
  }
  process.env.CB_FAKE_MARKER_DIR = markerDir
  const session = await backend.open({ kind: 'create', cwd: projectDir }, testHost ?? host())
  return { session, world, projectDir, markerDir }
}

async function closeSession(open) {
  await open.session.dispose().catch(() => {})
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      rmSync(open.world, { recursive: true, force: true })
      return
    } catch (error) {
      if (error?.code !== 'EPERM' && error?.code !== 'ENOTEMPTY') throw error
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
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

function readJsonl(markerDir, name) {
  const lines = []
  try {
    const raw = readFileSync(join(markerDir, name), 'utf8')
    for (const line of raw.split('\n')) {
      if (line.trim() !== '') lines.push(JSON.parse(line))
    }
  } catch {
    // no evidence yet
  }
  return lines
}

const THREE_MODELS = [
  { value: 'stub-model', displayName: 'Stub Base', description: 'the default' },
  { value: 'stub-pro', displayName: 'Stub Pro', description: '' },
  { value: 'stub-max', displayName: 'Stub Max' },
]

test('models.list maps the SDK initialize models to ModelOption (provider/id/label, empty description dropped)', async () => {
  const open = await openSession({ scenario: { models: THREE_MODELS } })
  try {
    const models = open.session.capabilities.models
    assert.equal(typeof models.list, 'function')
    assert.equal(typeof models.current, 'function')
    assert.equal(typeof models.set, 'function')
    const options = await models.list()
    assert.deepEqual(options, [
      { provider: 'codebuddy', id: 'stub-model', label: 'Stub Base', description: 'the default' },
      { provider: 'codebuddy', id: 'stub-pro', label: 'Stub Pro' },
      { provider: 'codebuddy', id: 'stub-max', label: 'Stub Max' },
    ])
  } finally {
    await closeSession(open)
  }
})

test('models.current reports the init frame model; set() switches, persists, and emits model.changed', async () => {
  const open = await openSession({ scenario: { models: THREE_MODELS } })
  try {
    const session = open.session
    const batches = collect(session)
    await waitFor(batches, readySeen, { what: 'session.ready' })

    assert.deepEqual(session.capabilities.models.current(), { provider: 'codebuddy', model: 'stub-model' })

    const outcome = await session.capabilities.models.set({ provider: 'codebuddy', model: 'stub-pro' })
    assert.deepEqual(outcome, { kind: 'switched' })
    assert.deepEqual(session.capabilities.models.current(), { provider: 'codebuddy', model: 'stub-pro' })

    const changed = flatten(batches).find(e => e.type === 'model.changed')
    assert.deepEqual(changed, { type: 'model.changed', model: 'stub-pro', provider: 'codebuddy', source: 'user' })

    // The switch physically reached the CLI as a set_model control request —
    // black-box evidence, not just local state.
    await waitFor([], () => readJsonl(open.markerDir, 'stub-model-requests.jsonl').length > 0, { what: 'set_model evidence' })
    const evidence = readJsonl(open.markerDir, 'stub-model-requests.jsonl')
    assert.equal(evidence.length, 1)
    assert.equal(evidence[0].subtype, 'set_model')
    assert.equal(evidence[0].model, 'stub-pro')
    assert.equal(evidence[0].session_id, session.ref.sessionId)
  } finally {
    await closeSession(open)
  }
})

test('the /model choice persists to backend prefs and the NEXT session opens with --model <choice>', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codebuddy-models-prefs-'))
  try {
    const first = await openSession({ testHost: host({ dataDir }), scenario: { models: THREE_MODELS } })
    try {
      const outcome = await first.session.capabilities.models.set({ provider: 'codebuddy', model: 'stub-max' })
      assert.deepEqual(outcome, { kind: 'switched' })
    } finally {
      await closeSession(first)
    }

    // A brand-new session on the same dataDir (the "restart" case) must spawn
    // its CLI with --model stub-max — proof the choice applies to the next
    // session open, not just the live one.
    const second = await openSession({ testHost: host({ dataDir }), scenario: { models: THREE_MODELS } })
    try {
      const deadline = Date.now() + 5000
      let argvEvidence = null
      while (Date.now() < deadline && argvEvidence === null) {
        for (const name of readdirSync(second.markerDir)) {
          if (!name.startsWith('stub-argv-')) continue
          const parsed = JSON.parse(readFileSync(join(second.markerDir, name), 'utf8'))
          if (parsed.argv.includes('--model')) { argvEvidence = parsed.argv; break }
        }
        if (argvEvidence === null) await new Promise(resolve => setTimeout(resolve, 25))
      }
      assert.ok(argvEvidence !== null, 'the next session CLI was spawned with --model')
      const modelIndex = argvEvidence.indexOf('--model')
      assert.equal(argvEvidence[modelIndex + 1], 'stub-max')
    } finally {
      await closeSession(second)
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('set() refuses invalid refs with a localized reason and touches nothing', async () => {
  for (const locale of ['zh', 'en']) {
    const open = await openSession({ testHost: host({ locale }) })
    try {
      const models = open.session.capabilities.models
      for (const bad of [undefined, null, 'stub-pro', {}, { model: '' }, { model: 42 }]) {
        const outcome = await models.set(bad)
        assert.deepEqual(outcome, { kind: 'refused', reason: outcome.reason })
        assert.ok(typeof outcome.reason === 'string' && outcome.reason.length > 0)
        assert.ok(locale === 'en' ? /invalid/i.test(outcome.reason) : outcome.reason.includes('无效'), `${locale}: ${outcome.reason}`)
      }
      assert.deepEqual(models.current(), { provider: 'codebuddy', model: 'stub-model' })
      assert.deepEqual(readJsonl(open.markerDir, 'stub-model-requests.jsonl'), [], 'no set_model reached the CLI')
    } finally {
      await closeSession(open)
    }
  }
})

test('set() on a disposed session refuses — no CLI is conjured from a dead transport', async () => {
  const open = await openSession()
  try {
    const session = open.session
    await session.dispose()
    const outcome = await session.capabilities.models.set({ provider: 'codebuddy', model: 'stub-pro' })
    assert.equal(outcome.kind, 'refused')
    assert.ok(typeof outcome.reason === 'string' && outcome.reason.length > 0)
    assert.deepEqual(readJsonl(open.markerDir, 'stub-model-requests.jsonl'), [])
  } finally {
    await closeSession(open)
  }
})

test('models.list on a disposed session fails loudly instead of respawning a CLI', async () => {
  const open = await openSession()
  try {
    await open.session.dispose()
    await assert.rejects(() => open.session.capabilities.models.list(), /不可用|unavailable/)
  } finally {
    await closeSession(open)
  }
})
