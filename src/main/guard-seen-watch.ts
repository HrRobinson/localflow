import { watch, mkdirSync, readdirSync } from 'node:fs'

export interface GuardSeenWatchOptions {
  dir: string
  /** Called with the marker filename (== paneId) each time a marker is written. */
  onSeen: (tag: string) => void
}

/**
 * Watches `dir` for per-pane invocation markers written by `saiifeguard check
 * --seen-dir`. Fires `onSeen(<paneId>)` on each write/rename. Best-effort:
 * observability, not enforcement — all failures are swallowed and can never
 * crash the main process. Returns a stop function.
 *
 * `fs.watch` is documented to silently coalesce/drop events under load, and
 * since each pane only ever writes its marker once, a single dropped event
 * would leave that pane's badge stuck forever. To self-heal, every poll tick
 * also sweeps the directory (mirroring guard-audit-tail.ts's resync-on-poll
 * pattern) and reports any marker the watch callback hasn't already reported.
 */
export function startGuardSeenWatch(opts: GuardSeenWatchOptions): () => void {
  try {
    mkdirSync(opts.dir, { recursive: true })
  } catch {
    /* best-effort */
  }
  // Tags already reported at least once, so the sweep doesn't re-invoke onSeen
  // for markers it (or the watch callback) already handled. The watch
  // callback itself still fires unconditionally, so repeated writes to the
  // same marker keep notifying as before.
  const reported = new Set<string>()
  let watcher: ReturnType<typeof watch> | null = null
  const arm = (): void => {
    try {
      watcher = watch(opts.dir, (_event, filename) => {
        if (typeof filename === 'string' && filename.length > 0) {
          reported.add(filename)
          opts.onSeen(filename)
        }
      })
      // An unhandled FSWatcher 'error' event throws by default (dir removed on
      // some platforms). Swallow it to keep the never-crash-main guarantee.
      watcher.on('error', () => {})
    } catch {
      /* dir not present yet; the interval re-arm covers it */
    }
  }
  arm()
  const sweep = (): void => {
    let entries: string[]
    try {
      entries = readdirSync(opts.dir)
    } catch {
      return // missing/unreadable dir; fail-open, same as the watch path
    }
    for (const filename of entries) {
      if (reported.has(filename)) continue
      reported.add(filename)
      opts.onSeen(filename)
    }
  }
  const interval = setInterval(() => {
    if (!watcher) arm()
    sweep()
  }, 1000)
  return () => {
    clearInterval(interval)
    watcher?.close()
  }
}
