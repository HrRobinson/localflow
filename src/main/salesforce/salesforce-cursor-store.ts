import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'

/**
 * Persists each poll subscription's `(timestamp, Id)` tuple cursor to a
 * NON-SECRET sidecar so a restart resumes without missing or re-firing a record
 * (spec §7, §4.5) — the PostHog `posthog-cursor-store` discipline, retargeted
 * from PostHog's `(timestamp, uuid)` to Salesforce's `(LastModifiedDate|
 * CreatedDate, Id)`. The sidecar holds ONLY the cursor — NO record fields and
 * NEVER a secret (spec §8).
 *
 * Atomic writes (temp + rename, as `credential-store.ts`), so a failed write
 * leaves no half-written blob and a missing/garbage sidecar is the normal
 * first-run case (start empty, never throw). The poller advances a cursor ONLY
 * AFTER handing the SeedEvent off, so a crash mid-poll re-processes rather than
 * drops (spec §7.2).
 */

/** The reconcile cursor: the newest handed-off `(timestamp, Id)` tuple (spec
 *  §7.2). `ts` is the trigger's timestamp field value; `id` is the 18-char Id. */
export interface SalesforceCursor {
  ts: string
  id: string
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export class SalesforceCursorStore {
  private readonly file: string
  private map: Record<string, SalesforceCursor>

  constructor(deps: { file: string }) {
    this.file = deps.file
    this.map = load(deps.file)
  }

  /** The persisted cursor for a subscription key, or undefined on first run. */
  get(key: string): SalesforceCursor | undefined {
    return this.map[key]
  }

  /** Persist a subscription's advanced cursor (atomic write). */
  set(key: string, cursor: SalesforceCursor): void {
    this.persist({ ...this.map, [key]: cursor })
  }

  /** Drop a subscription's cursor (on unsubscribe/teardown). */
  clear(key: string): void {
    if (!(key in this.map)) return
    const next = { ...this.map }
    delete next[key]
    this.persist(next)
  }

  private persist(next: Record<string, SalesforceCursor>): void {
    const tmp = `${this.file}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n')
      renameSync(tmp, this.file)
    } catch (err) {
      throw new Error(
        `Couldn't persist the Salesforce poll cursor — ${(err as Error).message}. ` +
          `The poll continues in-memory; a restart may re-check from the last saved cursor.`,
        { cause: err }
      )
    }
    this.map = next
  }
}

/** A missing/garbage sidecar is the normal first-run case — start empty. */
function load(file: string): Record<string, SalesforceCursor> {
  if (!existsSync(file)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!isObject(parsed)) return {}
    const out: Record<string, SalesforceCursor> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (isObject(v) && typeof v.ts === 'string' && typeof v.id === 'string') {
        out[k] = { ts: v.ts, id: v.id }
      }
    }
    return out
  } catch {
    return {}
  }
}
