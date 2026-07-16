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

export function noticeFromError(
  event: Pick<ErrorEvent, 'message'> & { error?: unknown }
): GlobalErrorState {
  return {
    message: 'An unexpected error occurred.',
    detail:
      event.error !== undefined && event.error !== null
        ? describeReason(event.error)
        : event.message
  }
}
