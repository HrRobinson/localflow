import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { SessionInfo } from '../../../shared/types'

interface Props {
  session: SessionInfo
  enlarged: boolean
  active: boolean
  onToggleEnlarge: () => void
  onActivate: () => void
  /** Relaunch the agent; `fresh` starts a new conversation instead of resuming. */
  onRestart: (fresh: boolean) => void
  onClose: () => void
}

export default function TerminalPane({
  session,
  enlarged,
  active,
  onToggleEnlarge,
  onActivate,
  onRestart,
  onClose
}: Props): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const alive = session.status !== 'exited'

  useEffect(() => {
    if (!alive || !hostRef.current) return
    const term = new Terminal({ fontSize: 12, theme: { background: '#1a1b1e' } })
    termRef.current = term
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current)
    fit.fit()
    window.localflow.resize(session.id, term.cols, term.rows)
    const offData = window.localflow.onData((id, data) => {
      if (id === session.id) term.write(data)
    })
    const onInput = term.onData((d) => window.localflow.write(session.id, d))
    const ro = new ResizeObserver(() => {
      fit.fit()
      window.localflow.resize(session.id, term.cols, term.rows)
    })
    ro.observe(hostRef.current)
    return () => {
      offData()
      onInput.dispose()
      ro.disconnect()
      term.dispose()
      termRef.current = null
    }
  }, [session.id, alive])

  // Keep DOM focus on the active pane's terminal — after activation changes,
  // and after the terminals view (re)mounts panes.
  useEffect(() => {
    if (active && alive) termRef.current?.focus()
  }, [active, alive])

  const name = session.cwd.split('/').filter(Boolean).pop() ?? session.cwd
  const agentLabel =
    session.agentId === 'custom' ? session.command.split('/').pop() : session.agentId
  const paneHeaderBtn =
    'cursor-pointer border-0 bg-transparent text-xs text-gray-400 hover:text-white'
  return (
    <div
      className={
        'pane border-exited bg-surface-raised flex min-h-0 flex-col overflow-hidden rounded-lg border-2' +
        (enlarged ? ' enlarged' : '') +
        (active ? ' active' : '')
      }
      data-pane-id={session.id}
      data-status={session.status}
      onMouseDown={onActivate}
    >
      <div
        className="pane-header flex cursor-pointer items-center gap-2 bg-white/[0.04] px-2.5 py-1 text-xs select-none"
        onDoubleClick={onToggleEnlarge}
      >
        <span className="dot bg-exited h-2.5 w-2.5 rounded-full" />
        <span
          className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
          title={session.cwd}
        >
          {name}
        </span>
        <span className="rounded bg-white/[0.06] px-1.5 py-px font-mono text-[10px] text-gray-400">
          {agentLabel}
        </span>
        <button
          className={paneHeaderBtn}
          onClick={onToggleEnlarge}
          onDoubleClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => {
            // preventDefault keeps focus off the button; stopPropagation keeps
            // the mousedown from bubbling to the pane root's onActivate —
            // closing a non-active pane must not first make it active.
            e.preventDefault()
            e.stopPropagation()
          }}
        >
          {enlarged ? 'shrink' : 'enlarge'}
        </button>
        <button
          className={paneHeaderBtn}
          onClick={onClose}
          onDoubleClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
        >
          close
        </button>
      </div>
      {alive ? (
        <div className="term-host min-h-0 flex-1 p-1" ref={hostRef} />
      ) : (
        <div className="restart-overlay flex flex-1 flex-col items-center justify-center gap-3">
          {session.message && (
            <p className="m-0 max-w-[80%] px-4 text-center text-[13px] text-gray-400">
              {session.message}
            </p>
          )}
          <div className="flex gap-2.5">
            <button
              className="cursor-pointer rounded-md border-0 bg-gray-700 px-4 py-2 text-white"
              onClick={() => onRestart(false)}
              onMouseDown={(e) => e.preventDefault()}
            >
              Resume conversation
            </button>
            <button
              className="cursor-pointer rounded-md border-0 bg-gray-700 px-4 py-2 text-white"
              onClick={() => onRestart(true)}
              onMouseDown={(e) => e.preventDefault()}
            >
              Start fresh
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
