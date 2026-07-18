import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'

/**
 * Persists each poll subscription's cursor to a NON-SECRET sidecar so a restart
 * resumes without missing or re-firing a signal (spec §7.4) — the email
 * `mailbox-registry` cursor discipline. The sidecar holds ONLY the cursor
 * (timestamps, uuids, a membership snapshot, a last insight value) — NO
 * analytics payload and NEVER a secret (spec §7.4, §8).
 *
 * The store is a small typed key→cursor map with atomic writes (temp + rename,
 * as `credential-store.ts`), so a failed write leaves no half-written blob and a
 * missing/garbage sidecar is the normal first-run case (start empty, never
 * throw). The poller advances a cursor ONLY AFTER handing the SeedEvent off, so
 * a crash mid-poll re-processes rather than drops (spec §7.2).
 */

/** The `event.matched` cursor: the newest seen `(timestamp, uuid)` (spec §7.2a). */
export interface EventCursor {
  kind: 'event'
  ts: string
  lastUuid: string
}

/** The `cohort.entered` cursor: the last-seen member snapshot (spec §7.2b). */
export interface CohortCursor {
  kind: 'cohort'
  members: string[]
}

/** The `insight.threshold` cursor: the last observed value (spec §7.2c). */
export interface InsightCursor {
  kind: 'insight'
  lastValue: number
}

export type PostHogCursor = EventCursor | CohortCursor | InsightCursor

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export class PostHogCursorStore {
  private readonly file: string
  private map: Record<string, PostHogCursor>

  constructor(deps: { file: string }) {
    this.file = deps.file
    this.map = load(deps.file)
  }

  /** The persisted cursor for a subscription key, or undefined on first run. */
  get(key: string): PostHogCursor | undefined {
    return this.map[key]
  }

  /** Persist a subscription's advanced cursor (atomic write). */
  set(key: string, cursor: PostHogCursor): void {
    this.persist({ ...this.map, [key]: cursor })
  }

  /** Drop a subscription's cursor (on unsubscribe/teardown). */
  clear(key: string): void {
    if (!(key in this.map)) return
    const next = { ...this.map }
    delete next[key]
    this.persist(next)
  }

  private persist(next: Record<string, PostHogCursor>): void {
    const tmp = `${this.file}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n')
      renameSync(tmp, this.file)
    } catch (err) {
      throw new Error(
        `Couldn't persist the PostHog poll cursor — ${(err as Error).message}. ` +
          `The poll continues in-memory; a restart may re-check from the last saved cursor.`,
        { cause: err }
      )
    }
    this.map = next
  }
}

/** A missing/garbage sidecar is the normal first-run case — start empty. */
function load(file: string): Record<string, PostHogCursor> {
  if (!existsSync(file)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!isObject(parsed)) return {}
    const out: Record<string, PostHogCursor> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (isValidCursor(v)) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

function isValidCursor(v: unknown): v is PostHogCursor {
  if (!isObject(v)) return false
  if (v.kind === 'event') return typeof v.ts === 'string' && typeof v.lastUuid === 'string'
  if (v.kind === 'cohort') return Array.isArray(v.members)
  if (v.kind === 'insight') return typeof v.lastValue === 'number'
  return false
}
