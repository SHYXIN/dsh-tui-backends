#!/usr/bin/env node
/**
 * live-smoke.mjs — T7 MVP 终验（真机 live 冒烟）：经 backend handler 导出面
 * （backend.js 的 detect / open / session 动词）驱动【真实 codebuddy CLI】，
 * 不用任何假桩，按验收清单执行并记录事件证据。零新依赖。
 *
 * 各步（与 issue #8 验收标准一一对应）：
 *   a. detect（真实版本）
 *   b. open 真实会话 → submit 最小提示词 → 断言真实流式增量与 completed 回合
 *   c. 需要工具授权的最小任务 ×2（issue 要求允许 + 拒绝各一次）：
 *      c1 允许一次（allow-once）→ 断言真实 tool.result 与文件真实落盘
 *      c2 拒绝一次（reject）→ 断言回合仍收口、文件未落盘
 *   d. 回合中途 cancel → 断言中断收口（terminal_reason 判定）与队列校正
 *      （运行中 cancel 收据为 unknown；cancel 前排入的 steer 在中断回合
 *       结束后接管为下一回合——队列快照与现实的校正）
 *   e. dispose → --resume 重开同一会话 → 断言历史回放种子与编号连续
 *      （种子 seq 1..K 无断号、回合 1..5 连续，live 续 turn 6）
 *
 * 用量纪律（票面）：提示词全部最小化（共 6 条最短提示词），不做长任务；
 * 证据只记录事件序列与关键数字，绝不包含凭据 / token / 完整账号值
 * （stderr 只记录存在性与脱敏尾巴，会话 id 只写前 8 位）。
 *
 * 运行：node packages/dsh-tui-codebuddy/scripts/live-smoke.mjs [--out <dir>]
 *   本脚本不进测试套件（消耗真实用量，单独可跑）。
 *   证据写入 --out 目录（默认临时目录）：
 *     live-smoke-evidence.json / live-smoke-evidence.md（脱敏摘要，可入档）
 *     live-smoke-events.json（完整事件流 + debug 尾巴——仅本地诊断，不入库）
 *   退出码：0 全部 PASS；1 有 FAIL；2 鉴权/开会话失败无法进行（证据照写）。
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detect, open } from '../backend.js'

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
let outDirArg = null
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--out' && typeof argv[i + 1] === 'string') {
    outDirArg = argv[i + 1]
    i += 1
  }
}

const startedAt = Date.now()

// 10 分钟硬上限：任何一步挂死都强制退出（watchdog 防证据也丢不了）。
const watchdog = setTimeout(() => {
  console.error('WATCHDOG: 10 分钟上限到达，强制退出（有步骤挂死）')
  process.exit(3)
}, 600_000)

// ── 最小提示词（用量纪律：全部最短化）─────────────────────────────────────
const PROMPT_CHAT = '只回复一个词：ok'
const PROMPT_WRITE_ALLOW = '在当前目录创建文件 allow-ok.txt，内容为 ok。只做这一件事，做完只回复 done。'
const PROMPT_WRITE_DENY = '在当前目录创建文件 deny-no.txt，内容为 ok。只做这一件事，做完只回复 done。'
const PROMPT_COUNT = '从 1 数到 30，每行一个数字，不要输出其他内容。'

let submitCount = 0 // 用量纪律的计数证据

// ── evidence scaffolding ───────────────────────────────────────────────────
let outDir
if (typeof outDirArg === 'string' && outDirArg !== '') {
  mkdirSync(outDirArg, { recursive: true })
  outDir = outDirArg
} else {
  outDir = mkdtempSync(join(tmpdir(), 'codebuddy-live-smoke-'))
}

const steps = []
let currentStep = null

function step(name) {
  currentStep = { name, status: 'PASS', checks: [], notes: [], sequence: undefined }
  steps.push(currentStep)
  console.log(`\n== ${name} ==`)
  return eventLog.length // marker for per-step sequence summary
}

function endStep(marker) {
  currentStep.sequence = seqSummaryRange(marker, eventLog.length)
}

function check(id, label, ok, extra = '') {
  const line = { id, label, ok: ok === true, ...(extra !== '' ? { extra } : {}) }
  currentStep.checks.push(line)
  if (!line.ok && currentStep.status === 'PASS') currentStep.status = 'FAIL'
  console.log(`${line.ok ? 'PASS' : 'FAIL'} ${id} ${label}${line.ok ? '' : `  (${extra})`}`)
}

function note(text) {
  currentStep.notes.push(text)
  console.log(`  … ${text}`)
}

// ── 脱敏：证据文件绝不包含凭据 / token / 完整账号值 ────────────────────────
function sanitize(text) {
  return String(text)
    .replace(/[\w.+-]+@[\w.-]+\.\w+/g, '[redacted-email]')
    .replace(/(Bearer\s+)\S+/gi, '$1[redacted]')
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[redacted-token]')
}

/** 会话 id 只写前 8 位（证据纪律）。 */
const sid = id => (typeof id === 'string' && id !== '' ? `${id.slice(0, 8)}…` : String(id))

// ── event log ──────────────────────────────────────────────────────────────
const eventLog = [] // {session: 's1'|'s2', t, ...event}

function recordEvents(tag, events) {
  if (!Array.isArray(events)) return
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    eventLog.push({ session: tag, t: Date.now(), ...event })
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Poll the log for the first event matching pred (optionally from an index
 *  marker, so per-turn waits never match an earlier turn's event). */
async function waitFor(tag, pred, timeoutMs, fromIdx = 0) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hit = eventLog.find((e, i) => i >= fromIdx && (tag === undefined || e.session === tag) && pred(e))
    if (hit !== undefined) return hit
    if (Date.now() >= deadline) return undefined
    await sleep(40)
  }
}

/** Compact "user.message → turn.start#1 → assistant.delta×14 → …" summary. */
function seqSummaryRange(from, to) {
  const parts = []
  let last = null
  const upTo = Math.min(to, eventLog.length)
  for (let i = from; i < upTo; i += 1) {
    const e = eventLog[i]
    const suffix = e.type === 'permission.settled' ? `(${e.outcome})`
      : e.type === 'turn.start' || e.type === 'turn.end' ? `#${e.turn}`
      : ''
    const key = `${e.session}:${e.type}${suffix}`
    if (last !== null && last.key === key) last.n += 1
    else { last = { key, n: 1 }; parts.push(last) }
  }
  return parts.map(p => (p.n === 1 ? p.key : `${p.key}×${p.n}`)).join(' → ')
}

// ── host stub（live：只补 host 缺的口，CLI 是真的）─────────────────────────
const debugLines = []
const stderrChunks = []
function makeHost(cwd) {
  return {
    cwd,
    locale: () => 'zh',
    debug(message) {
      debugLines.push(String(message))
      if (debugLines.length > 400) debugLines.splice(0, debugLines.length - 400)
    },
    stderr(data) {
      // 只存脱敏尾巴——绝不写凭据进证据。
      stderrChunks.push(sanitize(String(data)).slice(-400))
      if (stderrChunks.length > 20) stderrChunks.splice(0, stderrChunks.length - 20)
    },
  }
}

// ── 审批自动应答泵（事件驱动：request 一到就按当前策略回答）────────────────
function attachApprovals(session, policyBox, answered) {
  return events => {
    if (policyBox.current === null) return
    for (const event of events) {
      const requestId = event?.type === 'permission.request' ? event.request?.requestId : undefined
      if (typeof requestId === 'string' && !answered.has(requestId)) {
        answered.add(requestId)
        session.capabilities.permissions.respond(requestId, { kind: policyBox.current })
      }
    }
  }
}

// ── 小断言助手 ──────────────────────────────────────────────────────────────
const deltaCount = (tag, turnNo) =>
  eventLog.filter(e => e.session === tag && e.type === 'assistant.delta' && e.turn === turnNo).length
const hasAssistant = (tag, turnNo) =>
  eventLog.some(e => e.session === tag && e.type === 'assistant.message' && e.turn === turnNo)
const assistantText = (tag, turnNo) => {
  const msgs = eventLog.filter(e => e.session === tag && e.type === 'assistant.message' && e.turn === turnNo)
  return msgs
    .map(m => (Array.isArray(m.blocks) ? m.blocks : []).filter(b => b?.kind === 'text').map(b => b.text).join(' '))
    .join(' ')
}
const waitTurnEnd = (tag, turnNo, timeoutMs, fromIdx = 0) =>
  waitFor(tag, e => e.type === 'turn.end' && e.turn === turnNo, timeoutMs, fromIdx)

function seedSeqContiguous(seed) {
  let last = 0
  for (const event of seed) {
    if (typeof event?.seq !== 'number') continue
    if (event.seq !== last + 1) return false
    last = event.seq
  }
  return last > 0
}

function seedTurnsContiguous(seed) {
  const starts = seed.filter(e => e.type === 'turn.start').map(e => e.turn)
  for (let i = 0; i < starts.length; i += 1) if (starts[i] !== i + 1) return false
  return starts.length > 0
}

// ── main ───────────────────────────────────────────────────────────────────
let workDir = null
let authBlocked = false
let detection = null // module scope: the evidence builder reads it too

class Bail extends Error {
  constructor(exitCode) {
    super('bail')
    this.exitCode = exitCode
  }
}

try {
  workDir = mkdtempSync(join(tmpdir(), 'codebuddy-live-work-'))

  // ── step a: detect ────────────────────────────────────────────────────────
  let marker = step('a. detect（真实版本）')
  const hostDetect = makeHost(workDir)
  try {
    detection = await detect(hostDetect)
  } catch (error) {
    check('a0', 'detect 永不 throw', false, String(error?.message ?? error))
  }
  check('a1', 'detect installed:true（真实 CLI 在 PATH）', detection?.installed === true, JSON.stringify(detection ?? null))
  check('a2', '真实版本字符串非空', typeof detection?.version === 'string' && detection.version !== '', String(detection?.version ?? ''))
  endStep(marker)

  // ── step b: open + 最小对话 ───────────────────────────────────────────────
  marker = step('b. open 真实会话 → 最小提示词 → 流式与 completed')
  let session1 = null
  try {
    session1 = await open({ kind: 'create', cwd: workDir }, makeHost(workDir))
  } catch (error) {
    const reason = sanitize(String(error?.message ?? error))
    authBlocked = /login|登录|auth|credential|apikey|api key|未授权|unauthor/i.test(reason)
    check('b1', 'open() 成功', false, reason)
    note(authBlocked ? '疑似鉴权失败——按票面纪律停下，不尝试登录' : 'open() 失败')
    endStep(marker)
    throw new Bail(authBlocked ? 2 : 1)
  }

  const policyBox = { current: null }
  const answered = new Set()
  session1.subscribe(events => {
    recordEvents('s1', events)
    attachApprovals(session1, policyBox, answered)(events)
  })

  // 真机行为（live 发现）：本 CLI 构建的 system/init 不随握手到达，而是懒发
  // ——首个 stdin 输入之后才出现。所以先 submit 再等 ready（waitFor 扫全量
  // 日志，init 先到/后到两种顺序都覆盖）。
  submitCount += 1
  const sub1 = await session1.submit({ text: PROMPT_CHAT, clientMessageId: 'smoke-t1' })
  check('b2', 'submit accepted', sub1?.accepted === true, JSON.stringify(sub1 ?? null))
  const ready1 = await waitFor('s1', e => e.type === 'session.ready', 30_000)
  check('b1', 'session.ready 到达（真机：init 懒发，随首个输入后到）且会话 id 非空', ready1 !== undefined && typeof ready1.sessionId === 'string' && ready1.sessionId !== '')
  const readyModel = typeof ready1?.model === 'string' ? ready1.model : null
  const bundledVersion = typeof ready1?.backendVersion === 'string' ? ready1.backendVersion : null
  note(`init frame: model=${readyModel ?? '?'} codebuddy_code_version=${bundledVersion ?? '?'} permissionMode=${ready1?.permissionMode ?? '?'}`)
  note(`ref.sessionId=${sid(session1.ref.sessionId)} vs init sessionId=${sid(ready1?.sessionId)}${session1.ref.sessionId === ready1?.sessionId ? '（CLI 采纳 --session-id）' : '（CLI 采用自己的 id）'}`)
  const resumeId = ready1?.sessionId

  const end1 = await waitTurnEnd('s1', 1, 180_000)
  check('b3', 'turn.end(turn=1) 到达', end1 !== undefined)
  check('b4', '真实流式增量 ≥1', deltaCount('s1', 1) >= 1, `deltas=${deltaCount('s1', 1)}`)
  check('b5', 'assistant.message（canonical 行）到达', hasAssistant('s1', 1))
  check('b6', '回合 completed（terminal_reason 判定）', end1?.reason?.kind === 'completed', JSON.stringify(end1?.reason ?? null))
  note(`assistant 回复: ${JSON.stringify(assistantText('s1', 1))}`)
  endStep(marker)

  // ── step c1: 工具授权——允许一次 ─────────────────────────────────────────
  marker = step('c1. 工具授权——允许一次（allow-once）→ 真实 tool.result')
  policyBox.current = 'allow-once'
  const m2 = eventLog.length
  submitCount += 1
  const sub2 = await session1.submit({ text: PROMPT_WRITE_ALLOW, clientMessageId: 'smoke-t2' })
  check('c0', 'submit accepted', sub2?.accepted === true)
  const preq1 = await waitFor('s1', e => e.type === 'permission.request', 90_000, m2)
  check('c1', '审批面板事件 permission.request 到达', preq1 !== undefined)
  if (preq1 !== undefined) {
    note(`toolName=${preq1.request?.toolName} command=${JSON.stringify(preq1.request?.command ?? null)}`)
    check('c1a', '面板三选项齐备', Array.isArray(preq1.request?.options) && preq1.request.options.length === 3)
  }
  const pset1 = await waitFor('s1', e => e.type === 'permission.settled' && e.outcome === 'allow-once', 30_000, m2)
  check('c2', 'respond(allow-once) → permission.settled', pset1 !== undefined)
  const call2 = await waitFor('s1', e => e.type === 'tool.call', 30_000, m2)
  const result2 = await waitFor('s1', e => e.type === 'tool.result', 60_000, m2)
  check('c3', '真实 tool.call 到达', call2 !== undefined, `toolName=${call2?.name ?? '?'}`)
  check('c4', '真实 tool.result 到达且非 error', result2 !== undefined && result2.isError === false, JSON.stringify(result2 ? { isError: result2.isError } : null))
  const end2 = await waitTurnEnd('s1', 2, 180_000, m2)
  check('c5', '回合 completed', end2?.reason?.kind === 'completed', JSON.stringify(end2?.reason ?? null))
  let allowFileOk = false
  try {
    allowFileOk = existsSync(join(workDir, 'allow-ok.txt')) && readFileSync(join(workDir, 'allow-ok.txt'), 'utf8').trim() === 'ok'
  } catch { /* checked below */ }
  check('c6', '文件真实落盘且内容为 ok', allowFileOk)
  policyBox.current = null
  endStep(marker)

  // ── step c2: 工具授权——拒绝一次 ─────────────────────────────────────────
  marker = step('c2. 工具授权——拒绝一次（reject）→ 回合收口、文件不落盘')
  policyBox.current = 'reject'
  const m3 = eventLog.length
  submitCount += 1
  const sub3 = await session1.submit({ text: PROMPT_WRITE_DENY, clientMessageId: 'smoke-t3' })
  check('d0', 'submit accepted', sub3?.accepted === true)
  const preq2 = await waitFor('s1', e => e.type === 'permission.request', 90_000, m3)
  check('d1', '审批面板事件 permission.request 到达', preq2 !== undefined)
  const pset2 = await waitFor('s1', e => e.type === 'permission.settled' && e.outcome === 'rejected', 30_000, m3)
  check('d2', 'respond(reject) → permission.settled(rejected)', pset2 !== undefined)
  const end3 = await waitTurnEnd('s1', 3, 180_000, m3)
  check('d3', '拒绝后回合仍收口（completed）', end3?.reason?.kind === 'completed', JSON.stringify(end3?.reason ?? null))
  const deniedResults = eventLog.filter(e => e.session === 's1' && e.type === 'tool.result' && e.isError === true && e.turn === 3)
  note(`turn 3 的 error tool.result 数：${deniedResults.length}（拒绝以 isError 结果回给模型）`)
  check('d4', '被拒文件未落盘', !existsSync(join(workDir, 'deny-no.txt')))
  policyBox.current = null
  endStep(marker)

  // ── step d: 中途 cancel → 中断收口 + 队列校正 ───────────────────────────
  marker = step('d. 回合中途 cancel → terminal_reason 收口与队列校正')
  const m4 = eventLog.length
  submitCount += 1
  const sub4 = await session1.submit({ text: PROMPT_COUNT, clientMessageId: 'smoke-t4' })
  check('e1', 'submit accepted', sub4?.accepted === true)
  const firstDelta = await waitFor('s1', e => e.type === 'assistant.delta' && e.turn === 4, 120_000, m4)
  check('e2', '回合 4 已在产出流式增量', firstDelta !== undefined)
  // 队列校正验证：运行中排入一个 steer，user cancel 后它应接管为下一回合。
  submitCount += 1
  const sub5 = await session1.submit({ text: PROMPT_CHAT, clientMessageId: 'smoke-t5' }, 'steer')
  check('e3', '运行中 steer 排队 accepted', sub5?.accepted === true)
  const pend1 = await waitFor('s1', e => e.type === 'pending.changed' && (e.items ?? []).some(i => i.id === 'smoke-t5'), 15_000, m4)
  check('e4', 'pending.changed 显示排队项', pend1 !== undefined)
  const receipt = await session1.cancel('user')
  note(`cancel 收据: outcome=${receipt?.outcome} stillQueued=${JSON.stringify(receipt?.stillQueued ?? null)}`)
  check('e5', '运行中 cancel 收据为 unknown（T4 诚实语义）', receipt?.outcome === 'unknown', String(receipt?.outcome))
  check('e6', '收据快照仍含 steer（user cancel 不丢队列）', Array.isArray(receipt?.stillQueued) && receipt.stillQueued.includes('smoke-t5'), JSON.stringify(receipt?.stillQueued ?? null))
  const end4 = await waitTurnEnd('s1', 4, 40_000)
  check('e7', '中断收口：turn.end(turn=4) 到达（≤15s 强制收口上限内）', end4 !== undefined)
  // 真机签名（live 发现）：bundled 2.187.0 流式路径的中断 result 不携带
  // terminal_reason——'interrupt' 值在该构建根本不存在（CLI 的 abort 路径产出
  // 'aborted_streaming'/'aborted_tools'，见其 createCancelledResultMessage），
  // 可见中断信号是 CLI 合成的 "Interrupted by user" 助手消息。收口判定 =
  // 回合在窗口内结束 + （translator 的 interrupted 判定 或 该真机信号在场）；
  // 翻译器按真机证据校准的事记入遗留项。
  const synthesizedInterrupt = eventLog.some(e => e.session === 's1' && e.turn === 4 && e.type === 'assistant.message'
    && (Array.isArray(e.blocks) ? e.blocks : []).some(b => b?.kind === 'text' && typeof b.text === 'string' && /nterrupt/i.test(b.text)))
  check('e8', '中断收口判定（terminal_reason=interrupted 或真机合成中断信号）',
    end4 !== undefined && (end4.reason?.kind === 'interrupted' || synthesizedInterrupt),
    `reason=${JSON.stringify(end4?.reason ?? null)} synthesizedSignal=${synthesizedInterrupt}`)
  if (end4 !== undefined && end4.reason?.kind !== 'interrupted') {
    note(`真机偏离：turn.end reason=${JSON.stringify(end4.reason)}——流式中断 result 无 terminal_reason，收口信号是合成的 "Interrupted by user" 消息`)
  }
  const start5 = await waitFor('s1', e => e.type === 'turn.start' && e.turn === 5, 30_000)
  check('e9', '队列校正：steer 接管为下一回合(turn=5)', start5 !== undefined)
  const pend2 = await waitFor('s1', e => e.type === 'pending.changed' && (e.items ?? []).length === 0, 15_000)
  check('e10', 'pending 队列校正为空', pend2 !== undefined)
  const end5 = await waitTurnEnd('s1', 5, 180_000)
  check('e11', '中断后会话继续：turn 5 completed', end5?.reason?.kind === 'completed', JSON.stringify(end5?.reason ?? null))
  endStep(marker)

  // ── step e: dispose → --resume → 回放种子与编号连续 ──────────────────────
  marker = step('e. dispose → --resume 重开 → 回放种子与编号连续')
  const s1Seqs = eventLog.filter(e => e.session === 's1' && typeof e.seq === 'number').map(e => e.seq)
  note(`s1 持久记录事件 seq: 1..${Math.max(...s1Seqs)}（共 ${s1Seqs.length} 条）`)

  const disposePromise = session1.dispose()
  const disposedEvent = await waitFor('s1', e => e.type === 'session.status' && e.status === 'disposed', 15_000)
  await disposePromise
  check('f1', 'dispose → session.status disposed', disposedEvent !== undefined)

  let session2 = null
  try {
    session2 = await open({ kind: 'resume', sessionId: resumeId, cwd: workDir }, makeHost(workDir))
  } catch (error) {
    check('f2', '--resume 重开同一会话', false, sanitize(String(error?.message ?? error)))
    endStep(marker)
    throw new Bail(1)
  }
  session2.subscribe(events => recordEvents('s2', events))
  // history() 先行：回放 settle + 种子一次性交接（此后再问一律 []）。
  const seed = await session2.history()
  check('f3', '回放种子非空（history() 一次性交接）', Array.isArray(seed) && seed.length > 0, `len=${seed?.length}`)
  const seedUsers = Array.isArray(seed) ? seed.filter(e => e.type === 'user.message') : []
  check('f4', '种子含历史用户行（期望 5：对话/允许/拒绝/中断/续答）', seedUsers.length >= 4 && seedUsers.length <= 5, `got ${seedUsers.length}`)
  check('f5', '种子 seq 连续（1..K 无断号）', seedSeqContiguous(seed))
  check('f6', '种子回合编号连续（turn.start 1..K 无断号）', seedTurnsContiguous(seed), JSON.stringify({
    starts: seed.filter(e => e.type === 'turn.start').map(e => e.turn),
    ends: seed.filter(e => e.type === 'turn.end').map(e => e.turn),
  }))
  check('f7', '种子含真实工具卡（tool.call + tool.result）', seed.some(e => e.type === 'tool.call') && seed.some(e => e.type === 'tool.result'))
  // 真机行为（live 发现，回放 settle 策略偏离）：--resume 回放不含逐回合
  // result 帧——历史回合在种子中全部悬垂，唯一的 turn.end 是 settleReplay()
  // 合成的最后一个回合收口（reason=interrupted，即使该回合真实完成过）。
  // T5 的 fake-CLI 模型（每回合带 result）与真机不同——校准记入遗留项。
  const seedEnds = seed.filter(e => e.type === 'turn.end')
  note(`种子统计: len=${seed.length} turn.start=${seed.filter(e => e.type === 'turn.start').map(e => e.turn).join(',')} turn.end=${JSON.stringify(seedEnds.map(e => ({ turn: e.turn, reason: e.reason?.kind })))}`)
  note('真机偏离：--resume 回放无逐回合 result 帧——历史回合悬垂，收口由 settle 合成（记入遗留项·回放 settle 策略）')
  check('f8', '被中断回合的历史在种子中如实重放（turn 4 用户行在场）', seedUsers.some(e => e.turn === 4))

  // 真机 init 懒发：resume 会话的 ready 帧可能已在回放期到达，也可能仍要等
  // 首个输入——先提交再判定，waitFor 扫全量日志两种顺序都覆盖。
  const m6 = eventLog.length
  submitCount += 1
  const sub6 = await session2.submit({ text: PROMPT_CHAT, clientMessageId: 'smoke-t6' })
  const ready2 = await waitFor('s2', e => e.type === 'session.ready', 30_000)
  check('f2', '--resume 重开同一会话（init 确认同一 id）', ready2?.sessionId === resumeId, `init=${sid(ready2?.sessionId)} resume=${sid(resumeId)}`)
  const start6 = await waitFor('s2', e => e.type === 'turn.start' && e.turn === 6, 30_000, m6)
  check('f9', 'live 编号连续：turn.start = 6 = 种子最大回合 + 1', start6 !== undefined)
  const end6 = await waitTurnEnd('s2', 6, 180_000, m6)
  check('f10', 'resume 会话真实对话回合 completed', end6?.reason?.kind === 'completed', JSON.stringify(end6?.reason ?? null))
  const dispose2Promise = session2.dispose()
  await waitFor('s2', e => e.type === 'session.status' && e.status === 'disposed', 15_000)
  await dispose2Promise
  endStep(marker)
} catch (error) {
  if (!(error instanceof Bail)) {
    if (currentStep === null) step('意外异常')
    check('x0', '脚本未捕获异常', false, sanitize(error?.stack ?? error?.message ?? String(error)))
    if (currentStep) endStep(eventLog.length)
  }
} finally {
  const report = buildReport()
  writeEvidence(report)
  const passed = report.summary.passed
  const failed = report.summary.failed
  if (failed === 0 && !authBlocked) {
    console.log(`\nlive-smoke ALL PASS (${passed} checks)`)
    clearTimeout(watchdog)
    try { if (workDir !== null) rmSync(workDir, { recursive: true, force: true, maxRetries: 3 }) } catch { /* temp dir */ }
    process.exit(0)
  }
  console.log(`\nlive-smoke ${failed} FAILED${authBlocked ? '（鉴权失败，无法进行——按票面纪律停下，未尝试登录）' : ''}`)
  clearTimeout(watchdog)
  process.exit(authBlocked ? 2 : 1)
}

// ── report / evidence ───────────────────────────────────────────────────────
function buildReport() {
  const turnEnds = eventLog.filter(e => e.type === 'turn.end')
  const usageByTurn = turnEnds
    .filter(e => e.usage !== undefined)
    .map(e => ({ session: e.session, turn: e.turn, reason: e.reason?.kind, ...e.usage }))
  const creditsSnapshots = eventLog
    .filter(e => e.type === 'custom' && e.nativeType === 'codebuddy.turn-usage' && e.data?.kind === 'snapshot')
    .map(e => ({ session: e.session, credits: e.data.total?.credits, creditStatus: e.data.total?.creditStatus, usage: e.data.total?.usage ?? null }))
  const deltaTotal = eventLog.filter(e => e.type === 'assistant.delta').length
  const histogram = {}
  for (const e of eventLog) {
    histogram[e.type] = (histogram[e.type] ?? 0) + 1
  }
  const allChecks = steps.flatMap(s => s.checks)
  const ready1 = eventLog.find(e => e.session === 's1' && e.type === 'session.ready')
  return {
    meta: {
      invokedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      platform: `${process.platform} ${process.arch}`,
      node: process.version,
      cliDetected: typeof detection?.version === 'string' ? detection.version : null,
      cliBundled: typeof ready1?.backendVersion === 'string' ? ready1.backendVersion : null,
      initModel: typeof ready1?.model === 'string' ? ready1.model : null,
      // 账号形态：只写「已登录/未登录」形态判断，绝不写任何凭据或完整账号值。
      login: authBlocked ? '未能确认（open 失败，疑似未登录）' : '已登录（live 会话真实完成对话/审批/中断/恢复）',
      submits: submitCount,
      eventCount: eventLog.length,
      stderrChunksObserved: stderrChunks.length,
    },
    steps,
    usage: {
      perTurnTokens: usageByTurn,
      creditsSnapshots,
      deltaTotal,
      note: 'tokens 只经 assistant.message 记账；credits 只经 codebuddy.turn-usage custom 事件（T6 纪律）',
    },
    eventHistogram: histogram,
    summary: {
      passed: allChecks.filter(c => c.ok).length,
      failed: allChecks.filter(c => !c.ok).length,
    },
  }
}

function writeEvidence(report) {
  const jsonPath = join(outDir, 'live-smoke-evidence.json')
  const mdPath = join(outDir, 'live-smoke-evidence.md')
  const eventsPath = join(outDir, 'live-smoke-events.json')
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  writeFileSync(eventsPath, `${JSON.stringify({
    warning: '仅本地诊断：含完整会话 id 与临时路径，不入库、不提交。',
    events: eventLog,
    debugTail: debugLines.slice(-80),
    stderrTail: stderrChunks.slice(-6),
  }, null, 2)}\n`, 'utf8')

  const lines = [
    '# live-smoke 证据（live-smoke.mjs 自动生成）',
    '',
    `- 运行：${report.meta.invokedAt}（耗时 ${Math.round(report.meta.durationMs / 1000)}s）`,
    `- 平台：${report.meta.platform} / Node ${report.meta.node}`,
    `- CLI：detect(PATH)=${report.meta.cliDetected ?? '?'}；会话 init frame（SDK 捆绑）=${report.meta.cliBundled ?? '?'}；model=${report.meta.initModel ?? '?'}`,
    `- 账号形态：${report.meta.login}`,
    `- 提示词提交次数（全部最小化）：${report.meta.submits}`,
    `- 事件总数：${report.meta.eventCount}`,
    '',
    '## 各步结果',
    '',
  ]
  for (const s of steps) {
    lines.push(`### ${s.name} — ${s.status}`)
    for (const c of s.checks) lines.push(`- ${c.ok ? 'PASS' : 'FAIL'} ${c.id} ${c.label}${c.ok ? '' : `（${c.extra}）`}`)
    for (const n of s.notes) lines.push(`  - note: ${n}`)
    if (s.sequence !== undefined && s.sequence !== '') lines.push(`  - 事件序列: ${s.sequence}`)
    lines.push('')
  }
  lines.push('## 用量数字', '')
  for (const t of report.usage.perTurnTokens) {
    lines.push(`- ${t.session} turn ${t.turn}（${t.reason}）: input=${t.input ?? 0} output=${t.output ?? 0}`)
  }
  for (const c of report.usage.creditsSnapshots) {
    lines.push(`- ${c.session} credits snapshot: credits=${c.credits ?? '?'} status=${c.creditStatus ?? '?'} tokens(input=${c.usage?.input ?? '?'}, output=${c.usage?.output ?? '?'})`)
  }
  lines.push(`- 流式增量总数：${report.usage.deltaTotal}`)
  lines.push('')
  lines.push('## 事件直方图', '')
  for (const [type, count] of Object.entries(report.eventHistogram)) lines.push(`- ${type}: ${count}`)
  lines.push('')
  lines.push(`检查统计：${report.summary.passed} PASS / ${report.summary.failed} FAIL`)
  lines.push('')
  lines.push('完整事件流（本地诊断，不入库）：live-smoke-events.json')
  writeFileSync(mdPath, `${lines.join('\n')}\n`, 'utf8')
  console.log(`\n证据已写入：\n  ${mdPath}\n  ${jsonPath}\n  ${eventsPath}`)
}
