/**
 * The CodeBuddy permission bridge (ticket T3) — the session's `canUseTool`
 * callback. Every prompt parks here and surfaces to the channel as a
 * `permission.request` carrying the host's `PermissionRequestView`:
 *
 *  - three options, always: allow once / allow always / reject (the panel's
 *    user-visible labels come from the bundle's bilingual dict, picked at
 *    park time from the live host locale);
 *  - the user's answer comes back through `respond` and becomes the
 *    `PermissionResult` the CLI expects.
 *
 * The SDK 0.3.307 difference (notes §5 / codebuddy-sdk.md §10.7): an allow is
 * answered with `{behavior:'allow', updatedInput, toolUseID}` and NEVER
 * `updatedPermissions` — the SDK forwards only allowed/updatedInput/tool_use_id
 * to the CLI, so a "remember this" payload would be dead weight anyway.
 * Persistence of an allow-always choice is entirely the CLI's own business;
 * this bundle writes no settings file.
 *
 * Deadlock rules (each covered by the session tests):
 *  1. the SDK's abort signal (interrupt via the SDK, abort, process exit)
 *     settles the prompt as withdrawn (`permission.settled{cancelled}`);
 *  2. dispose / transport death / a leaving cancel answer every pending
 *     prompt at once (`settleAll`) before the query closes — the panel never
 *     hangs on a session that is going away;
 *  3. parallel prompts all park; the shared store shows them in park order;
 *  4. the callback never throws: a failure while building a prompt denies it.
 */

import { codebuddyText } from './text.js'
import { toolSubject } from './presentation.js'

/** The model-facing refusal (goes to the CLI, not to a human — English like
 *  the claude bridge's model-facing constants). */
const REJECT_MESSAGE = 'User denied permission to run this tool'
/** What a withdrawn prompt resolves with (the CLI records its own refusal). */
const WITHDRAWN_MESSAGE = 'The permission prompt was withdrawn'
/** What a prompt still open at dispose resolves with. */
const CLOSED_MESSAGE = 'The session closed before the user answered'

function isRec(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Create the bridge for one session.
 *
 * @param {object} deps
 *   emit(events): deliver events to the channel (buffered until subscribed)
 *   debug(message): opt-in diagnostics, never user-visible
 *   locale(): live host locale ('zh' | 'en') — labels bake at park time
 *   closing(): true once the session is closing (new prompts refused at once)
 *   onPendingChange(count): parked-prompt count changed (session status)
 */
export function createCodebuddyPermissionBridge(deps) {
  const pending = new Map()
  let requestCounter = 0

  /** The panel's option labels: backend-dict text in the live locale. */
  const optionLabel = kind => codebuddyText(`permission-${kind}`, deps.locale())

  const changed = () => {
    try {
      deps.onPendingChange?.(pending.size)
    } catch (error) {
      deps.debug(`codebuddy: pending-change listener failed (${error?.message})`)
    }
  }

  /** Settle one prompt: resolve its callbacks, tell the channel, once. */
  const settle = (entry, result, outcome) => {
    if (pending.get(entry.requestId) !== entry) return
    pending.delete(entry.requestId)
    for (const detach of entry.detachers.splice(0)) detach()
    for (const resolve of entry.resolvers.splice(0)) resolve(result)
    deps.emit([{ type: 'permission.settled', requestId: entry.requestId, outcome }])
    changed()
  }

  const deny = (entry, message) => ({
    behavior: 'deny',
    message,
    toolUseID: entry.toolUseID,
  })

  /** The allow the CLI expects — plain, no updatedPermissions (SDK 0.3.307
   *  drops them on the wire; allow-always persistence is the CLI's business). */
  const allow = entry => ({
    behavior: 'allow',
    updatedInput: entry.input,
    toolUseID: entry.toolUseID,
  })

  const listen = (entry, signal) => {
    const onAbort = () => {
      settle(entry, deny(entry, WITHDRAWN_MESSAGE), 'cancelled')
    }
    signal.addEventListener('abort', onAbort, { once: true })
    return () => signal.removeEventListener('abort', onAbort)
  }

  const canUseTool = (toolName, input, options) => new Promise(resolve => {
    try {
      requestCounter += 1
      const requestId = `perm-${requestCounter}`
      if (deps.closing()) {
        resolve({ behavior: 'deny', message: CLOSED_MESSAGE, toolUseID: options.toolUseID })
        return
      }
      const safeInput = isRec(input) ? input : {}
      const subject = toolSubject(safeInput)
      const entry = {
        requestId,
        toolUseID: options.toolUseID,
        input: safeInput,
        resolvers: [resolve],
        detachers: [],
        view: {
          requestId,
          toolName: typeof toolName === 'string' ? toolName : 'unknown',
          callId: options.toolUseID,
          input: safeInput,
          // Three options, always — the ticket's approval trio. Labels are
          // backend-dict text baked at park time in the live locale.
          options: [
            { id: 'allow-once', kind: 'allow-once', label: optionLabel('allow-once') },
            { id: 'allow-always', kind: 'allow-always', label: optionLabel('allow-always') },
            { id: 'reject', kind: 'reject', label: optionLabel('reject') },
          ],
          feedback: true,
          // One line naming what the tool would do (shape-driven, no name
          // special-casing).
          ...(subject === undefined ? {} : { command: subject }),
          ...(options.decisionReason === undefined ? {} : { reason: options.decisionReason }),
          ...(options.blockedPath === undefined ? {} : { blockedPath: options.blockedPath }),
          ...(options.agentID === undefined ? {} : { agentId: options.agentID }),
        },
      }
      pending.set(requestId, entry)
      if (options.signal?.aborted) {
        settle(entry, deny(entry, WITHDRAWN_MESSAGE), 'cancelled')
        return
      }
      if (options.signal) entry.detachers.push(listen(entry, options.signal))
      deps.emit([{ type: 'permission.request', request: entry.view }])
      changed()
    } catch (error) {
      // Rule 4: a prompt this bridge cannot present is refused, never a hang.
      deps.debug(`codebuddy: permission prompt failed (${error?.message})`)
      resolve({ behavior: 'deny', message: REJECT_MESSAGE, toolUseID: options.toolUseID })
    }
  })

  /** The user decided a parked prompt (`capabilities.permissions.respond`). */
  const respond = (requestId, decision) => {
    const entry = pending.get(requestId)
    if (entry === undefined) {
      deps.debug(`codebuddy: respond for unknown permission request ${requestId}`)
      return
    }
    switch (decision?.kind) {
      case 'allow-once':
        settle(entry, allow(entry), 'allow-once')
        return
      case 'allow-always':
        settle(entry, allow(entry), 'allow-always')
        return
      case 'reject': {
        const reason = typeof decision.message === 'string' ? decision.message.trim() : ''
        settle(entry, deny(entry, reason === '' ? REJECT_MESSAGE : `${REJECT_MESSAGE}: ${reason}`), 'rejected')
        return
      }
      default:
        deps.debug(`codebuddy: unknown permission decision ${JSON.stringify(decision?.kind)}`)
    }
  }

  return {
    canUseTool,
    respond,
    /** Every parked tool prompt, in park order. */
    pendingViews: () => [...pending.values()].map(entry => entry.view),
    get size() {
      return pending.size
    },
    /** Withdraw everything (dispose, switch, transport death). */
    settleAll: () => {
      for (const entry of [...pending.values()]) settle(entry, deny(entry, CLOSED_MESSAGE), 'cancelled')
    },
  }
}
