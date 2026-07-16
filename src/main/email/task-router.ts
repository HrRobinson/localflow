/**
 * Maps an inbound message/thread onto a localflow pane (design §4.4), keyed by
 * provider thread id. MVP strategy: pane-per-thread, 1:1 — the pane's lifecycle
 * IS the task's lifecycle, so the `working → needs-you → done` status feed (§4.5)
 * maps cleanly.
 *
 * It takes a pane-creation *seam* (a plain function), NOT the real control-API —
 * so the whole router is unit-testable offline (§10). Wiring the seam to
 * `SessionManager` / `PaneRegistry` is a later, separate step.
 *
 * The router also owns the per-task draft state, which is what the approval
 * gate's peek resolves through (§4.6): an email pane's peek is the DRAFT BODY,
 * not the pty tail. `peekFor` returns null when no draft is pending yet, so the
 * caller falls back to the existing `extractPeekLines` behavior.
 */

import type { SessionStatus } from '../../shared/types'
import type { DraftPeek } from '../../shared/email'
import type { DraftRef, EmailMessage } from './provider'

/** A request handed to the pane-creation seam for one inbound thread. */
export interface EmailPaneRequest {
  readonly threadId: string
  readonly subject: string
  readonly environment: number
}

/** The pane working one email thread. */
export interface EmailTask {
  readonly threadId: string
  readonly paneHandle: string
}

export interface TaskRouterDeps {
  /** Which localflow environment hosts this mailbox's panes (§8). */
  readonly environment: number
  /** Create (or resurrect) an agent pane for a thread; returns its handle. */
  readonly createPane: (request: EmailPaneRequest) => string
}

interface TaskState {
  readonly threadId: string
  readonly paneHandle: string
  draft: DraftRef | null
  peek: DraftPeek | null
}

export class TaskRouter {
  private readonly byThread = new Map<string, TaskState>()
  private readonly byPane = new Map<string, TaskState>()

  constructor(private readonly deps: TaskRouterDeps) {}

  /**
   * Route an inbound message to its thread's pane, spawning one on first sight
   * and reusing it for later messages in the same thread (pane-per-thread).
   */
  route(message: EmailMessage): EmailTask {
    const existing = this.byThread.get(message.threadId)
    if (existing) return { threadId: existing.threadId, paneHandle: existing.paneHandle }

    const paneHandle = this.deps.createPane({
      threadId: message.threadId,
      subject: message.subject,
      environment: this.deps.environment
    })
    const state: TaskState = { threadId: message.threadId, paneHandle, draft: null, peek: null }
    this.byThread.set(message.threadId, state)
    this.byPane.set(paneHandle, state)
    return { threadId: state.threadId, paneHandle }
  }

  /**
   * Attach the draft the agent created to its task. The task now awaits human
   * approval — its status becomes `needs-you` and its peek becomes the draft
   * body. Never sends (that is `draft-gate` only, on approval).
   */
  attachDraft(threadId: string, draft: DraftRef, peek: DraftPeek): void {
    const state = this.byThread.get(threadId)
    if (!state) {
      throw new Error(
        `Can't attach a draft to thread ${threadId} — no email task pane is tracking it. ` +
          `A draft can only be attached to a routed inbound thread.`
      )
    }
    state.draft = draft
    state.peek = peek
  }

  /**
   * The status a given pane surfaces: `needs-you` once a draft awaits approval,
   * otherwise `working` (the agent is reading/reasoning/drafting). The live feed
   * is still the authority (§4.5); this is the resolution seam the tests drive.
   */
  statusFor(paneHandle: string): SessionStatus {
    return this.byPane.get(paneHandle)?.draft ? 'needs-you' : 'working'
  }

  /**
   * The approval peek for an email pane: the DRAFT BODY (§4.6), or null when no
   * draft is pending — in which case the caller falls back to the pty tail.
   */
  peekFor(paneHandle: string): DraftPeek | null {
    return this.byPane.get(paneHandle)?.peek ?? null
  }

  /** The `DraftRef` the approval gate will send for this pane, if one is pending. */
  draftFor(paneHandle: string): DraftRef | null {
    return this.byPane.get(paneHandle)?.draft ?? null
  }
}
