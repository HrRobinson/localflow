/**
 * Shared Sentry connector types — the NORMALIZED, stable shapes an action writes
 * to run context (spec §6.3) and the action-param / trigger-payload shapes the
 * engine templates. Imported by main (the connector/normalizer/webhook server)
 * and any renderer palette surface.
 *
 * NO raw Sentry REST shape lives here — those are isolated in
 * `src/main/sentry/sentry-api.ts` (the API blast radius, §4.1). This file holds
 * ONLY localflow-facing, already-normalized vocabulary: the flattened
 * `frames[]` + `topInAppFrame` a downstream GitHub fix-node consumes, the issue
 * fields conditions route on, and the pinned id tuples the templates track reads.
 */

// ── Pinned dev/incident vocabulary ids (§6.4 — templates + GitHub tracks read) ─

/** Webhook-backed trigger ids (§6.1). `issue.regressed` is DERIVED (the
 *  connector filters an `unresolved` event to `substatus === 'regressed'`). */
export const SENTRY_TRIGGER_IDS = ['issue.created', 'issue.regressed', 'alert.triggered'] as const
export type SentryTriggerId = (typeof SENTRY_TRIGGER_IDS)[number]

/** Read action ids — pure reads that write the fix context for conditions and
 *  the GitHub node (§6.2). `getEvent` is the load-bearing one. */
export const SENTRY_READ_ACTION_IDS = ['getIssue', 'getEvent', 'searchIssues'] as const

/** Gated-mutation action ids — the author places a gate (or a merged-PR signal)
 *  before these (§6.2, §9). */
export const SENTRY_MUTATION_ACTION_IDS = [
  'resolveIssue',
  'assignIssue',
  'ignoreIssue',
  'commentIssue'
] as const

export type SentryActionId =
  (typeof SENTRY_READ_ACTION_IDS)[number] | (typeof SENTRY_MUTATION_ACTION_IDS)[number]

/** Sentry webhook resources this connector handles (§6.1). */
export type SentryResource = 'issue' | 'event_alert'

// ── Context-field shapes (§6.3 — PINNED; guarded by the normalize tests) ──────

export type SentryLevel = 'error' | 'warning' | 'info' | 'debug' | 'fatal' | 'sample'
export type SentryStatus = 'unresolved' | 'resolved' | 'ignored'

/** One stack frame — the atom a fix worker edits (§6.3). */
export interface SentryStackFrame {
  /** e.g. "src/checkout/cart.ts" — the file to fix. */
  filename: string
  /** Absolute/URL path as Sentry recorded it. */
  absPath: string
  /** Enclosing function, e.g. "applyDiscount". */
  function: string
  /** 1-based line — the line to fix. */
  lineNo: number
  colNo?: number
  module?: string
  /** true = the app's own code (a fix target), not a dependency. */
  inApp: boolean
  /** The source line itself, when Sentry has it. */
  contextLine?: string
}

export interface SentryIssueContext {
  issue: {
    /** Numeric issue id, e.g. "4509876543". */
    id: string
    /** Human id, e.g. "FRONTEND-42". */
    shortId: string
    title: string
    /** Sentry's culprit, e.g. "cart.ts in applyDiscount". */
    culprit: string
    level: SentryLevel
    status: SentryStatus
    /** e.g. "regressed" | "new" | "ongoing". */
    substatus?: string
    /** The Sentry UI URL (for PR bodies / comments). */
    permalink: string
    /** e.g. "javascript", "python". */
    platform: string
    /** Project slug. */
    project: string
    /** Event count (severity signal for conditions). */
    count: number
    userCount: number
    /** ISO 8601. */
    firstSeen: string
    /** ISO 8601. */
    lastSeen: string
  }
}

export interface SentryEventContext {
  event: {
    /** Event id (32-char hex). */
    id: string
    issueId: string
    message: string
    culprit: string
    platform: string
    /** The primary exception, flattened for conditions. */
    exception: {
      type: string
      value: string
    }
    /** Full stack, app + dependency frames (crash-nearest LAST — Sentry order). */
    frames: SentryStackFrame[]
    /** Just the app's own frames (the fix targets). */
    inAppFrames: SentryStackFrame[]
    /** The single most useful pointer for a fix PR: the crash-nearest in-app
     *  frame, or undefined if none is in-app. */
    topInAppFrame?: SentryStackFrame
    permalink: string
  }
}

/** What a verified webhook seeds a run with (§6.1). For `alert.triggered` the
 *  inline `event` is present so the stack trace needs no extra fetch. */
export interface SentryTriggerPayload {
  issueId: string
  shortId: string
  projectSlug: string
  level: string
  culprit: string
  /** Carries "regressed" for the derived trigger. */
  substatus?: string
  resource: SentryResource
  /** "created" | "unresolved" | "triggered" | … */
  action?: string
  /** Inline for `alert.triggered`. */
  event?: SentryEventContext['event']
}

// ── Action param shapes (what a flow node passes to `invokeAction`) ───────────

export interface GetIssueParams {
  id: string
}

export interface GetEventParams {
  id: string
  /** A specific event id; omitted → the issue's latest event. */
  eventId?: string
}

export interface SearchIssuesParams {
  /** Sentry issue-search syntax, e.g. "is:unresolved level:error". */
  query?: string
}

/** Resolve-in-commit / -release detail (§2.2, §7). When present, the client uses
 *  the PROJECT-scoped endpoint so `inCommit`/`inRelease` actually apply. */
export interface SentryStatusDetails {
  inCommit?: { commit: string; repository?: string }
  inRelease?: string
  inNextRelease?: boolean
  ignoreDuration?: number
  ignoreCount?: number
}

export interface ResolveIssueParams {
  id: string
  statusDetails?: SentryStatusDetails
}

export interface AssignIssueParams {
  id: string
  /** "user:<id>" | "team:<id>". */
  assignedTo: string
}

export interface IgnoreIssueParams {
  id: string
  statusDetails?: SentryStatusDetails
}

export interface CommentIssueParams {
  id: string
  text: string
}

/** `searchIssues` result — the normalized issues plus a count (§6.2). */
export interface SentryIssueSearchContext {
  issues: SentryIssueContext[]
  count: number
}
