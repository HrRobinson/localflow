import React from 'react'
import {
  deriveErrorState,
  initialErrorBoundaryState,
  type ErrorBoundaryState
} from './errorBoundaryState'

interface ErrorBoundaryProps {
  children: React.ReactNode
}

// SYS-1: top-level render-crash net. Wraps <App/> in main.tsx so that an
// uncaught exception anywhere in the component tree no longer white-screens
// the whole window with zero message. Fallback carries a human sentence, a
// Reload action, and the raw error/component stack behind a <details> for
// anyone debugging a bug report (same "human sentence then technical depth"
// shape used elsewhere in the app, e.g. TerminalPane's resume-failed panel).
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = initialErrorBoundaryState

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return deriveErrorState(error)
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null })
    // No devtools console in a packaged build's normal UI, but this still
    // gives us a trail in dev and in any main-process log tee.
    console.error('[ErrorBoundary] renderer crash', error, info.componentStack)
  }

  private handleReload = (): void => {
    window.location.reload()
  }

  render(): React.ReactNode {
    const { error, componentStack } = this.state
    if (!error) {
      return this.props.children
    }

    return (
      <div className="error-boundary-fallback flex h-screen w-screen flex-col items-center justify-center gap-4 bg-black p-8 text-center text-white">
        <p className="m-0 max-w-[32rem] text-[15px] text-gray-200">
          localflow hit an unexpected error and this view was stopped.
        </p>
        <button
          type="button"
          className="cursor-pointer rounded-md border-0 bg-gray-700 px-4 py-2 text-white"
          onClick={this.handleReload}
          onMouseDown={(e) => e.preventDefault()}
        >
          Reload
        </button>
        <details className="max-w-[32rem] text-left text-[12px] text-gray-400">
          <summary className="cursor-pointer select-none">Technical details</summary>
          <pre className="m-0 mt-2 max-h-64 overflow-auto break-words whitespace-pre-wrap">
            {error.message}
            {componentStack ? `\n${componentStack}` : ''}
          </pre>
        </details>
      </div>
    )
  }
}

export default ErrorBoundary
