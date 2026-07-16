import { Terminal } from '@xterm/headless'

/**
 * A DOM-less xterm.js terminal that renders a pane's pty byte stream so the
 * operator control API can read the *screen* (clean, de-escaped text) instead
 * of a regex-stripped raw byte tail. Every public method swallows throws and
 * degrades to "unavailable" (snapshot() returns []), so a headless-emulator
 * failure can never crash the main process or the control API — callers fall
 * back to the byte-tail path. One instance per live pane; scrollback is a
 * fixed 1000 rows to bound memory.
 */
export class TerminalScreen {
  private term: Terminal
  private broken = false

  constructor(cols = 80, rows = 24) {
    this.term = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true })
  }

  /**
   * DEVIATION from the plan's "key implementation fact": against the
   * installed @xterm/headless@6, `Terminal.write()` is NOT synchronous for a
   * cold write buffer — it always defers to `setTimeout(0)` unless the
   * internal `_didUserInput` flag is set (verified empirically; see the
   * WriteBuffer.write source). That would make `snapshot()` read stale/empty
   * data immediately after `write()`, breaking every caller that feeds pty
   * bytes and reads back in the same tick (SessionManager's data handler,
   * instant-exit message, peek/output).
   *
   * The only way to parse synchronously is the internal (unsupported, "will
   * be removed soon" per upstream) `Terminal._core.writeSync()`. Used here
   * because `writeSync` renders synchronously, so the ONLY same-tick reader —
   * the instant-exit `onExit` message, which reads the screen right after
   * feeding it the final pty bytes — sees the final frame. (SessionManager's
   * regular data handler only writes; it does not read back in the same
   * tick.) Guarded: if a future @xterm/headless removes `writeSync`, this
   * silently falls back to the async public `write()` — snapshot() then
   * simply returns [] until the next tick, and SessionManager.snapshot falls
   * back to the byte-tail path. Never throws, never worse than before — a
   * safe degradation.
   */
  write(data: string): void {
    if (this.broken) return
    try {
      const core = (this.term as unknown as { _core?: { writeSync?: (d: string) => void } })._core
      if (core?.writeSync) {
        core.writeSync(data)
      } else {
        this.term.write(data)
      }
    } catch {
      this.broken = true
    }
  }

  resize(cols: number, rows: number): void {
    if (this.broken) return
    try {
      this.term.resize(cols, rows)
    } catch {
      this.broken = true
    }
  }

  /**
   * The rendered screen as plain text lines. Trailing blank lines are trimmed.
   * With `maxLines`, returns the last N non-empty lines (matching the old
   * extractPeekLines contract). Any failure yields [] so callers fall back.
   */
  snapshot(maxLines?: number): string[] {
    if (this.broken) return []
    try {
      const buf = this.term.buffer.active
      const lines: string[] = []
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i)
        lines.push(line ? line.translateToString(true) : '')
      }
      while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
        lines.pop()
      }
      if (maxLines != null) {
        return lines.filter((l) => l.trim().length > 0).slice(-maxLines)
      }
      return lines
    } catch {
      this.broken = true
      return []
    }
  }

  dispose(): void {
    // DEVIATION: the plan assumed a write against a disposed Terminal would
    // throw (tripping the `broken` flag via write()'s own catch). Verified
    // against the real library: the internal writeSync path used above
    // happily keeps mutating the disposed buffer without throwing. Set
    // `broken` explicitly so post-dispose write/resize/snapshot are hard
    // no-ops regardless of what the underlying library does.
    this.broken = true
    try {
      this.term.dispose()
    } catch {
      /* already gone */
    }
  }
}
