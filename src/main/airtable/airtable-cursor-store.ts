import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'

/**
 * Persists each watched webhook's `/payloads` cursor to a NON-SECRET sidecar so a
 * restart resumes without missing or re-firing a change (spec §4.3) — a direct
 * analog of `posthog-cursor-store.ts` with a trivially small cursor shape. The
 * sidecar holds ONLY the cursor (a webhook id + a monotonic integer) — NEVER a
 * record, NEVER the PAT, NEVER the webhook MAC secret (spec §4.3, §5).
 *
 * Atomic writes (temp + rename, as `credential-store.ts`), so a failed write
 * leaves no half-written blob and a missing/garbage sidecar is the normal
 * first-run case (start empty, never throw). The poller advances a cursor ONLY
 * AFTER handing its SeedEvents off, so a crash mid-poll re-fetches from the last
 * durable cursor rather than dropping a change (spec §4.2).
 */

/** The `/payloads` cursor: a webhook id + the monotonic integer to pass NEXT as
 *  `?cursor=` (spec §4.3). */
export interface AirtableCursor {
  kind: 'payloads'
  webhookId: string
  cursor: number
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export class AirtableCursorStore {
  private readonly file: string
  private map: Record<string, AirtableCursor>

  constructor(deps: { file: string }) {
    this.file = deps.file
    this.map = load(deps.file)
  }

  /** The persisted cursor for a webhook key, or undefined on first run. */
  get(key: string): AirtableCursor | undefined {
    return this.map[key]
  }

  /** Persist a webhook's advanced cursor (atomic write). */
  set(key: string, cursor: AirtableCursor): void {
    this.persist({ ...this.map, [key]: cursor })
  }

  /** Drop a webhook's cursor (on unsubscribe/teardown). */
  clear(key: string): void {
    if (!(key in this.map)) return
    const next = { ...this.map }
    delete next[key]
    this.persist(next)
  }

  private persist(next: Record<string, AirtableCursor>): void {
    const tmp = `${this.file}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n')
      renameSync(tmp, this.file)
    } catch (err) {
      throw new Error(
        `Couldn't persist the Airtable poll cursor — ${(err as Error).message}. ` +
          `The poll continues in-memory; a restart may re-check from the last saved cursor.`,
        { cause: err }
      )
    }
    this.map = next
  }
}

/** A missing/garbage sidecar is the normal first-run case — start empty. */
function load(file: string): Record<string, AirtableCursor> {
  if (!existsSync(file)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!isObject(parsed)) return {}
    const out: Record<string, AirtableCursor> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (isValidCursor(v)) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

function isValidCursor(v: unknown): v is AirtableCursor {
  return (
    isObject(v) &&
    v.kind === 'payloads' &&
    typeof v.webhookId === 'string' &&
    typeof v.cursor === 'number'
  )
}
