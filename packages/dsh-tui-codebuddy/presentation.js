/**
 * Tool-card presentation picker (ticket T3): the card shapes are the host's
 * backend-neutral `ToolPresentation` vocabulary — `ToolCallView` /
 * `ToolResultView` card variants (generic / terminal / diff / …), declared
 * here by shape since the bundle is an island (host-surface notes §7B).
 *
 * Shape-driven, deliberately NOT name-keyed: the cards below are picked from
 * what the model put in the tool input (a `command` string, an old/new string
 * pair, a `pattern`…), so an unknown or renamed tool renders just as well and
 * nothing downstream ever special-cases a tool name. A shape this module does
 * not recognise degrades to no presentation at all — the host then renders the
 * plain generic card from the call's args.
 *
 * Every reader narrows `unknown`: inputs come from the model.
 */

const MAX_TAIL_LINES = 200
const MAX_TAIL_CHARS = 16 * 1024

function isRec(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function str(value) {
  return typeof value === 'string' ? value : undefined
}

const nonEmpty = value => (typeof value === 'string' && value !== '' ? value : undefined)

/** The input's file-ish path, if it names one. */
function filePathOf(input) {
  return nonEmpty(input.file_path) ?? nonEmpty(input.notebook_path)
}

/** How a call renders while it runs (`ToolCallPresentation`). */
export function presentToolCall(rawInput, cwd) {
  if (!isRec(rawInput)) return undefined
  const input = rawInput
  const command = nonEmpty(input.command)
  if (command !== undefined) {
    const description = nonEmpty(input.description)
    return { card: 'terminal', title: command, ...(description !== undefined ? { description } : {}), cwd }
  }
  const filePath = filePathOf(input)
  if (filePath !== undefined) {
    const oldText = nonEmpty(input.old_string)
    const newText = nonEmpty(input.new_string)
    if (oldText !== undefined && newText !== undefined) {
      // Snippet pair: the position in the file is unknown, so the card shows
      // the hunks without line numbers (the host's convention).
      return { card: 'diff', title: filePath, diffs: [{ path: filePath, oldText, newText }] }
    }
    const content = nonEmpty(input.content)
    if (content !== undefined) {
      // Whole new content with no before-image: a new-file write.
      return { card: 'diff', title: filePath, diffs: [{ path: filePath, oldText: null, newText: content }] }
    }
    return { card: 'generic', title: filePath }
  }
  const pattern = nonEmpty(input.pattern)
  if (pattern !== undefined) {
    const where = nonEmpty(input.path)
    return { card: 'generic', title: where === undefined ? pattern : `${pattern} · ${where}` }
  }
  const url = nonEmpty(input.url)
  if (url !== undefined) return { card: 'generic', title: url }
  const query = nonEmpty(input.query)
  if (query !== undefined) return { card: 'generic', title: query }
  return undefined
}

/** The bounded tail of a run's output for the settled card (host-surface
 *  notes semantics: at most 200 lines / 16 KiB, whole lines only). Returns
 *  `{output, dropped}` — dropped is the number of head lines cut. */
export function boundedTail(text) {
  const lines = text.split('\n')
  const kept = lines.slice(-MAX_TAIL_LINES)
  let dropped = lines.length - kept.length
  while (kept.length > 1 && kept.join('\n').length > MAX_TAIL_CHARS) {
    kept.shift()
    dropped += 1
  }
  return { output: kept.join('\n'), dropped }
}

/** How a settled result renders (`ToolResultPresentation`); undefined = the
 *  plain-text card the host builds from `tool.result.text`. Errors never get
 *  a structured card (the error text is the card). */
export function presentToolResult(rawInput, outcome, localeText) {
  if (outcome.isError) return undefined
  if (!isRec(rawInput)) return undefined
  const input = rawInput
  if (nonEmpty(input.command) === undefined) return undefined
  const { output, dropped } = boundedTail(outcome.text)
  // SDK 0.3.307 has no live-stdout frame, so there is no `tool.output` stream
  // to forward; the bounded-tail semantics land on the settled card instead.
  const head = dropped > 0 ? `${localeText('card-tail-dropped', { count: dropped })}\n` : ''
  return { card: 'terminal', output: head + output }
}

/** One line naming what the tool would do — the approval panel's `command`.
 *  Same shape-driven discipline as the cards; unreadable inputs degrade to a
 *  clipped JSON dump (claude's fallback convention). */
export function toolSubject(rawInput) {
  if (!isRec(rawInput)) return undefined
  const input = rawInput
  const direct = nonEmpty(input.command)
    ?? filePathOf(input)
    ?? nonEmpty(input.url)
    ?? nonEmpty(input.query)
  if (direct !== undefined) return direct
  const pattern = nonEmpty(input.pattern)
  if (pattern !== undefined) {
    const where = nonEmpty(input.path)
    return where === undefined ? pattern : `${pattern} · ${where}`
  }
  let json
  try {
    json = JSON.stringify(input)
  } catch {
    return undefined
  }
  if (json === undefined || json === '{}') return undefined
  return json.length <= 300 ? json : `${json.slice(0, 300)}…`
}
