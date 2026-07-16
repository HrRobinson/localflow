// Pure state-derivation logic for ErrorBoundary.tsx, split out into a plain
// .ts module (no JSX) so it can be imported from tests/unit, which
// type-checks under tsconfig.node.json (no --jsx flag) rather than
// tsconfig.web.json.
export interface ErrorBoundaryState {
  error: Error | null
  componentStack: string | null
}

export const initialErrorBoundaryState: ErrorBoundaryState = {
  error: null,
  componentStack: null
}

export function deriveErrorState(error: Error): Partial<ErrorBoundaryState> {
  return { error }
}
