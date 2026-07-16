import { watch, mkdirSync } from 'node:fs'

export interface GuardSeenWatchOptions {
  dir: string
  /** Called with the marker filename (== paneId) each time a marker is written. */
  onSeen: (tag: string) => void
}

/**
 * Watches `dir` for per-pane invocation markers written by `lfguard check
 * --seen-dir`. Fires `onSeen(<paneId>)` on each write/rename. Best-effort:
 * observability, not enforcement — all failures are swallowed and can never
 * crash the main process. Returns a stop function.
 */
export function startGuardSeenWatch(opts: GuardSeenWatchOptions): () => void {
  try {
    mkdirSync(opts.dir, { recursive: true })
  } catch {
    /* best-effort */
  }
  let watcher: ReturnType<typeof watch> | null = null
  const arm = (): void => {
    try {
      watcher = watch(opts.dir, (_event, filename) => {
        if (typeof filename === 'string' && filename.length > 0) opts.onSeen(filename)
      })
      // An unhandled FSWatcher 'error' event throws by default (dir removed on
      // some platforms). Swallow it to keep the never-crash-main guarantee.
      watcher.on('error', () => {})
    } catch {
      /* dir not present yet; the interval re-arm covers it */
    }
  }
  arm()
  const interval = setInterval(() => {
    if (!watcher) arm()
  }, 1000)
  return () => {
    clearInterval(interval)
    watcher?.close()
  }
}
