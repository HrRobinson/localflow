import { watch, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import type { GuardAuditRecord } from '../shared/console'

/** Parse newline-delimited audit JSON, skipping blanks/junk/incomplete records. */
export function parseAuditLines(text: string): GuardAuditRecord[] {
  const out: GuardAuditRecord[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    let obj: unknown
    try {
      obj = JSON.parse(t)
    } catch {
      continue
    }
    if (typeof obj !== 'object' || obj === null) continue
    const r = obj as Record<string, unknown>
    if (
      typeof r.ts === 'number' &&
      typeof r.command === 'string' &&
      typeof r.reason === 'string' &&
      typeof r.pack === 'string' &&
      (r.tag === null || typeof r.tag === 'string')
    ) {
      out.push({ ts: r.ts, tag: (r.tag as string | null) ?? null, command: r.command, reason: r.reason, pack: r.pack })
    }
  }
  return out
}

export interface AuditTailOptions {
  path: string
  onRecords: (records: GuardAuditRecord[]) => void
}

/**
 * Tail an append-only audit log: reads new bytes appended since the last
 * read and emits parsed records. Best-effort; failures are swallowed
 * (observability, not enforcement). Returns a stop function.
 */
export function startGuardAuditTail(opts: AuditTailOptions): () => void {
  let offset = existsSync(opts.path) ? statSync(opts.path).size : 0
  const readNew = (): void => {
    try {
      if (!existsSync(opts.path)) return
      const size = statSync(opts.path).size
      if (size <= offset) {
        offset = size // truncated/rotated → resync
        return
      }
      const fd = openSync(opts.path, 'r')
      const buf = Buffer.alloc(size - offset)
      readSync(fd, buf, 0, buf.length, offset)
      closeSync(fd)
      offset = size
      const records = parseAuditLines(buf.toString('utf8'))
      if (records.length) opts.onRecords(records)
    } catch {
      /* best-effort */
    }
  }
  // fs.watch fires on append; guard against missing file by watching the dir is
  // overkill here — the file is created lazily by lfguard, so poll-on-watch.
  let watcher: ReturnType<typeof watch> | null = null
  const arm = (): void => {
    try {
      watcher = watch(opts.path, () => readNew())
    } catch {
      /* file not present yet; a later arm() retry covers it */
    }
  }
  arm()
  const interval = setInterval(() => {
    if (!watcher) arm()
    readNew()
  }, 1000)
  return () => {
    clearInterval(interval)
    watcher?.close()
  }
}
