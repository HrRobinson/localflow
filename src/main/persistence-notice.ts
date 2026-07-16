/**
 * Routes persistence save-failure notices to the renderer with two guarantees
 * the naive "re-send only when the error string changes" de-dupe got wrong:
 *
 *   1. A notice raised before the window exists (e.g. a save failure during the
 *      pre-window startup restore — the disk-full / permissions-at-launch case)
 *      is BUFFERED and FLUSHED once the window is ready, instead of being
 *      dropped by a no-op send and then permanently muted by the de-dupe.
 *   2. De-dupe suppresses an already-DELIVERED identical error, never one that
 *      was never shown — a recurring cold-start failure still reaches the user.
 *
 * `send` returns true when the message was actually delivered (a live window),
 * false when there is no window to receive it yet.
 */
export class PersistenceNoticeRouter {
  private lastDelivered: string | null = null
  private buffered: string | null = null

  constructor(private readonly send: (message: string) => boolean) {}

  /**
   * Call with each save result: the error string on failure, or `null` on a
   * successful save (which clears state so a later, distinct failure is
   * re-announced and a pre-window failure that has since recovered isn't shown).
   */
  report(error: string | null): void {
    if (error === null) {
      this.lastDelivered = null
      this.buffered = null
      return
    }
    // Already shown this exact error — don't spam an identical toast.
    if (error === this.lastDelivered) return
    if (this.send(error)) {
      this.lastDelivered = error
      this.buffered = null
    } else {
      // No window yet: hold it so it isn't lost, and leave lastDelivered unset
      // so the de-dupe can't mute a notice the user has never actually seen.
      this.buffered = error
    }
  }

  /** Call once the window is ready to receive pushes (e.g. did-finish-load). */
  flush(): void {
    if (this.buffered !== null && this.send(this.buffered)) {
      this.lastDelivered = this.buffered
      this.buffered = null
    }
  }
}
