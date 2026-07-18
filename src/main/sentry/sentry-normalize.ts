import type {
  RawSentryEvent,
  RawSentryExceptionValue,
  RawSentryFrame,
  RawSentryIssue
} from './sentry-api'
import type {
  SentryEventContext,
  SentryIssueContext,
  SentryLevel,
  SentryResource,
  SentryStackFrame,
  SentryStatus,
  SentryTriggerId,
  SentryTriggerPayload
} from '../../shared/sentry'

/**
 * PURE normalization (spec §6.3) — the correctness boundary the conditions track
 * AND the sibling GitHub fix-node depend on. This is where Sentry's raw shapes
 * become the PINNED context shape ONCE: the nested
 * `entries[exception].data.values[].stacktrace.frames[]` is flattened into a flat
 * `frames[]`, the app's own frames are selected into `inAppFrames`, and the
 * crash-nearest in-app frame is exposed as `topInAppFrame` — the single
 * `file:line` pointer a fix worker starts from. Never throws — a sparse/garbage
 * node normalizes to safe defaults so a malformed read never crashes a run
 * (mirrors `shopify-normalize.ts` purity).
 *
 * Frame order: Sentry returns stack frames oldest-call-first, so the frame where
 * the crash actually happened is LAST. `topInAppFrame` is therefore the LAST
 * in-app frame — the most recent, crash-nearest one the fix belongs in.
 */

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function num(v: unknown): number {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const LEVELS: readonly string[] = ['error', 'warning', 'info', 'debug', 'fatal', 'sample']
function level(v: unknown): SentryLevel {
  const s = str(v).toLowerCase()
  return (LEVELS.includes(s) ? s : 'error') as SentryLevel
}

const STATUSES: readonly string[] = ['unresolved', 'resolved', 'ignored']
function status(v: unknown): SentryStatus {
  const s = str(v).toLowerCase()
  return (STATUSES.includes(s) ? s : 'unresolved') as SentryStatus
}

// ── Issue ─────────────────────────────────────────────────────────────────────

/** A raw issue node (REST or webhook `data.issue`) → the pinned issue context. */
export function normalizeIssue(node: RawSentryIssue): SentryIssueContext {
  const issue: SentryIssueContext['issue'] = {
    id: str(node.id),
    shortId: str(node.shortId),
    title: str(node.title),
    culprit: str(node.culprit),
    level: level(node.level),
    status: status(node.status),
    permalink: str(node.permalink),
    platform: str(node.platform),
    project: str(node.project?.slug),
    count: num(node.count),
    userCount: num(node.userCount),
    firstSeen: str(node.firstSeen),
    lastSeen: str(node.lastSeen)
  }
  const substatus = str(node.substatus)
  if (substatus.length > 0) issue.substatus = substatus
  return { issue }
}

// ── Event / stack trace (the load-bearing flatten) ───────────────────────────

/** One raw frame → a normalized `SentryStackFrame`. Picks the source line from
 *  an explicit `contextLine` or the `context` array entry matching `lineNo`. */
function normalizeFrame(raw: RawSentryFrame): SentryStackFrame {
  const lineNo = num(raw.lineNo)
  const frame: SentryStackFrame = {
    filename: str(raw.filename),
    absPath: str(raw.absPath),
    function: str(raw.function),
    lineNo,
    inApp: raw.inApp === true
  }
  if (typeof raw.colNo === 'number') frame.colNo = raw.colNo
  const module = str(raw.module)
  if (module.length > 0) frame.module = module
  const contextLine = contextLineFor(raw, lineNo)
  if (contextLine !== undefined) frame.contextLine = contextLine
  return frame
}

function contextLineFor(raw: RawSentryFrame, lineNo: number): string | undefined {
  if (typeof raw.contextLine === 'string' && raw.contextLine.length > 0) return raw.contextLine
  if (Array.isArray(raw.context)) {
    for (const pair of raw.context) {
      if (Array.isArray(pair) && Number(pair[0]) === lineNo && typeof pair[1] === 'string') {
        return pair[1]
      }
    }
  }
  return undefined
}

/** The primary exception value — the outermost/thrown one, which Sentry places
 *  LAST in a chained `values[]` (cause-first, thrown-last). */
function primaryException(values: RawSentryExceptionValue[]): RawSentryExceptionValue | undefined {
  return values.length > 0 ? values[values.length - 1] : undefined
}

/** Pull the exception entry's `data.values` out of the event `entries`. */
function exceptionValues(node: RawSentryEvent): RawSentryExceptionValue[] {
  const entries = Array.isArray(node.entries) ? node.entries : []
  const exception = entries.find((e) => e?.type === 'exception')
  const values = exception?.data?.values
  return Array.isArray(values) ? values : []
}

/**
 * A raw event node (REST latest-event or the inline webhook event) → the pinned
 * event context, with frames flattened out of the nested exception stacktrace,
 * `inAppFrames` filtered, and `topInAppFrame` = the crash-nearest in-app frame.
 */
export function normalizeEvent(node: RawSentryEvent): SentryEventContext {
  const values = exceptionValues(node)
  const primary = primaryException(values)
  const rawFrames = Array.isArray(primary?.stacktrace?.frames) ? primary!.stacktrace!.frames! : []
  const frames = rawFrames.map(normalizeFrame)
  const inAppFrames = frames.filter((f) => f.inApp)
  // Crash-nearest in-app frame = the LAST in-app frame (Sentry orders oldest-first).
  const topInAppFrame = inAppFrames.length > 0 ? inAppFrames[inAppFrames.length - 1] : undefined

  const event: SentryEventContext['event'] = {
    id: str(node.eventID ?? node.id),
    issueId: str(node.groupID ?? node.issueId),
    message: str(node.message ?? node.title),
    culprit: str(node.culprit),
    platform: str(node.platform),
    exception: {
      type: str(primary?.type),
      value: str(primary?.value)
    },
    frames,
    inAppFrames,
    permalink: str(node.permalink)
  }
  if (topInAppFrame) event.topInAppFrame = topInAppFrame
  return { event }
}

// ── Webhook body → trigger payload (§6.1) ────────────────────────────────────

/**
 * Normalize a raw (untrusted) webhook body into a `SentryTriggerPayload`, or
 * `null` when the resource is unsupported or the body carries no usable issue id
 * (so no run is ever seeded on garbage — spec §4.4). For `event_alert` the
 * triggering event is normalized inline so the stack trace needs no extra fetch.
 */
export function webhookToPayload(resource: string, raw: unknown): SentryTriggerPayload | null {
  if (!isObj(raw)) return null
  const action = typeof raw.action === 'string' ? raw.action : undefined
  const data = isObj(raw.data) ? raw.data : {}

  if (resource === 'issue') {
    const issueNode = isObj(data.issue) ? (data.issue as RawSentryIssue) : null
    if (!issueNode) return null
    const issueId = str(issueNode.id)
    if (issueId.length === 0) return null
    const payload: SentryTriggerPayload = {
      issueId,
      shortId: str(issueNode.shortId),
      projectSlug: str(issueNode.project?.slug),
      level: level(issueNode.level),
      culprit: str(issueNode.culprit),
      resource: 'issue'
    }
    const substatus = str(issueNode.substatus)
    if (substatus.length > 0) payload.substatus = substatus
    if (action) payload.action = action
    return payload
  }

  if (resource === 'event_alert') {
    const eventNode = isObj(data.event) ? (data.event as RawSentryEvent) : null
    if (!eventNode) return null
    const event = normalizeEvent(eventNode).event
    const issueNode = isObj(data.issue) ? (data.issue as RawSentryIssue) : null
    const issueId = event.issueId || str(issueNode?.id)
    if (issueId.length === 0) return null
    const payload: SentryTriggerPayload = {
      issueId,
      shortId: str(issueNode?.shortId),
      projectSlug: str(issueNode?.project?.slug),
      level: level(issueNode?.level),
      culprit: event.culprit || str(issueNode?.culprit),
      resource: 'event_alert',
      event
    }
    if (action) payload.action = action
    return payload
  }

  return null
}

/**
 * Which pinned trigger id(s) a verified resource + normalized payload fires.
 * `issue`/`created` → `issue.created`. `issue`/`unresolved` is the DERIVED
 * regression: it fires `issue.regressed` ONLY when `substatus === 'regressed'`
 * (an ordinary un-resolve fires nothing — spec §2.3). `event_alert` →
 * `alert.triggered`. Anything else fires nothing.
 */
export function triggersFor(resource: string, payload: SentryTriggerPayload): SentryTriggerId[] {
  if (resource === 'issue') {
    if (payload.action === 'created') return ['issue.created']
    if (payload.action === 'unresolved' && payload.substatus === 'regressed') {
      return ['issue.regressed']
    }
    return []
  }
  if (resource === 'event_alert') return ['alert.triggered']
  return []
}

export function isSupportedResource(resource: string): resource is SentryResource {
  return resource === 'issue' || resource === 'event_alert'
}
