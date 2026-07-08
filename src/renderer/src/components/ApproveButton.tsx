import { useEffect, useRef, useState } from 'react'

interface Props {
  sessionId: string
  /** Trigger-button styling, supplied by the host context (pane header vs row). */
  buttonClassName: string
  /** Pane-header buttons must not bubble mousedown into pane activation. */
  stopMouseDown?: boolean
}

/**
 * The needs-you Approve control: arm-then-confirm, never blind. Arming
 * fetches a peek of the session's recent output (the pending question) and
 * shows it beside the confirm button; confirming writes Enter — the
 * agent-agnostic "accept the highlighted option" keystroke — to the
 * session's pty. Outside click or bare Escape disarms, same idiom as the
 * overview rows' delete confirmation.
 */
export default function ApproveButton({
  sessionId,
  buttonClassName,
  stopMouseDown
}: Props): React.JSX.Element {
  // null = disarmed; a string[] (possibly empty) = armed, holding the peek.
  const [peek, setPeek] = useState<string[] | null>(null)
  const wrapRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (peek === null) return
    const onDocMouseDown = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setPeek(null)
    }
    const onDocKeyDown = (e: KeyboardEvent): void => {
      // Deliberately not stopPropagation'd: bare Escape always reaches the
      // agent (see README) — the terminal keeps focus while the popover is
      // open, so this same keypress also disarms and falls through to the pty.
      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) setPeek(null)
    }
    window.addEventListener('mousedown', onDocMouseDown)
    window.addEventListener('keydown', onDocKeyDown)
    return () => {
      window.removeEventListener('mousedown', onDocMouseDown)
      window.removeEventListener('keydown', onDocKeyDown)
    }
  }, [peek])

  const onMouseDown = (e: React.MouseEvent): void => {
    // preventDefault keeps DOM focus where it is; stopPropagation (pane
    // headers only) keeps the click from activating the pane.
    e.preventDefault()
    if (stopMouseDown) e.stopPropagation()
  }

  const approve = (): void => {
    // \r is what a terminal Enter sends through a pty.
    window.localflow.write(sessionId, '\r')
    setPeek(null)
  }

  return (
    <span className="relative" ref={wrapRef}>
      <button
        className={`approve-btn ${buttonClassName}`}
        onClick={() =>
          void window.localflow
            .peekSession(sessionId)
            .then(setPeek)
            .catch(() => setPeek([]))
        }
        onDoubleClick={(e) => e.stopPropagation()}
        onMouseDown={onMouseDown}
      >
        approve
      </button>
      {peek !== null && (
        <div
          className="approve-pop bg-surface-raised absolute top-full right-0 z-20 mt-1 w-72 rounded-md border border-yellow-500/40 p-2 shadow-lg"
          onDoubleClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => {
            // The popover floats over other mousedown-sensitive chrome
            // (terminal, pane root) — interacting with it must not
            // activate/focus anything underneath.
            e.preventDefault()
            if (stopMouseDown) e.stopPropagation()
          }}
        >
          <pre className="approve-peek m-0 mb-2 max-h-28 overflow-auto font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-gray-300">
            {peek.length > 0 ? peek.join('\n') : '(no recent output)'}
          </pre>
          <div className="flex justify-end gap-1.5">
            <button
              className="approve-cancel cursor-pointer rounded-md border border-white/10 bg-white/[0.07] px-2 py-1 text-xs text-gray-300 hover:bg-white/[0.13] hover:text-white"
              onClick={() => setPeek(null)}
              onMouseDown={onMouseDown}
            >
              Cancel
            </button>
            <button
              className="approve-confirm cursor-pointer rounded-md border border-yellow-500/50 bg-yellow-500/15 px-2 py-1 text-xs text-yellow-300 hover:bg-yellow-500/25"
              onClick={approve}
              onMouseDown={onMouseDown}
            >
              Send ⏎
            </button>
          </div>
        </div>
      )}
    </span>
  )
}
