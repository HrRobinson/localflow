// Pure event -> notice mapping logic for GlobalErrorNotice.tsx, split out
// into a plain .ts module (no JSX) so it can be imported from tests/unit,
// which type-checks under tsconfig.node.json (no --jsx flag) rather than
// tsconfig.web.json.
export interface GlobalErrorState {
  message: string
  detail: string
}

// Turns whatever a rejected promise threw into a printable technical detail.
export function describeReason(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.stack ?? reason.message
  }
  if (typeof reason === 'string') {
    return reason
  }
  try {
    return JSON.stringify(reason)
  } catch {
    return String(reason)
  }
}

export function noticeFromRejection(
  event: Pick<PromiseRejectionEvent, 'reason'>
): GlobalErrorState {
  return {
    message: 'An action failed in the background.',
    detail: describeReason(event.reason)
  }
}

// Known-benign `window` 'error' messages that Chromium dispatches as real
// error events but that carry no actionable information for the user.
// ResizeObserver's loop-limit warnings are the textbook example: this app's
// own TerminalPane runs a ResizeObserver that calls xterm's FitAddon.fit()
// synchronously, which is exactly what triggers them. Industry-standard to
// ignore (e.g. Sentry ignores these by default) -- surfacing a red toast for
// them just teaches users to distrust the notice. Keep this list narrow and
// specific; do not broaden it to swallow genuine errors.
const BENIGN_ERROR_SUBSTRINGS = [
  'resizeobserver loop limit exceeded',
  'resizeobserver loop completed with undelivered notifications'
]

export function isBenignErrorMessage(message: string): boolean {
  if (!message) {
    return false
  }
  const lower = message.toLowerCase()
  return BENIGN_ERROR_SUBSTRINGS.some((benign) => lower.includes(benign))
}

export function noticeFromError(
  event: Pick<ErrorEvent, 'message'> & { error?: unknown }
): GlobalErrorState | null {
  if (isBenignErrorMessage(event.message)) {
    return null
  }
  return {
    message: 'An unexpected error occurred.',
    detail:
      event.error !== undefined && event.error !== null
        ? describeReason(event.error)
        : event.message
  }
}
