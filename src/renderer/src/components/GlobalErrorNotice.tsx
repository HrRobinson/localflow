import React, { useCallback, useEffect, useState } from 'react'
import { noticeFromError, noticeFromRejection, type GlobalErrorState } from './globalErrorLogic'

// SYS-2: last-resort net for silent fire-and-forget IPC rejections and any
// other uncaught error at the window level. Renders as a sibling of <App/>
// inside the ErrorBoundary wrapper in main.tsx (never via App.tsx state) so
// it surfaces regardless of what App is doing.
export function GlobalErrorNotice(): React.ReactElement | null {
  const [error, setError] = useState<GlobalErrorState | null>(null)

  const handleRejection = useCallback((event: PromiseRejectionEvent) => {
    setError(noticeFromRejection(event))
  }, [])

  const handleError = useCallback((event: ErrorEvent) => {
    setError(noticeFromError(event))
  }, [])

  useEffect(() => {
    window.addEventListener('unhandledrejection', handleRejection)
    window.addEventListener('error', handleError)
    return () => {
      window.removeEventListener('unhandledrejection', handleRejection)
      window.removeEventListener('error', handleError)
    }
  }, [handleRejection, handleError])

  if (!error) {
    return null
  }

  return (
    <div className="global-error-notice fixed bottom-2 left-1/2 z-50 max-w-[80%] -translate-x-1/2 rounded-md border border-red-500/50 bg-red-500/15 px-3 py-1.5 text-[12px] text-red-200">
      <span>
        {error.message} {error.detail}
      </span>
      <button
        className="ml-3 cursor-pointer border-0 bg-transparent text-red-200/70 hover:text-white"
        onClick={() => setError(null)}
        onMouseDown={(e) => e.preventDefault()}
      >
        dismiss
      </button>
    </div>
  )
}

export default GlobalErrorNotice
