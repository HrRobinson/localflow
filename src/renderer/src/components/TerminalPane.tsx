import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { SessionInfo } from '../../../shared/types'

interface Props {
  session: SessionInfo
  enlarged: boolean
  onToggleEnlarge: () => void
  onRestart: () => void
  onClose: () => void
}

export default function TerminalPane({
  session,
  enlarged,
  onToggleEnlarge,
  onRestart,
  onClose
}: Props): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const alive = session.status !== 'exited'

  useEffect(() => {
    if (!alive || !hostRef.current) return
    const term = new Terminal({ fontSize: 12, theme: { background: '#1a1b1e' } })
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
    }
  }, [session.id, alive])

  const name = session.cwd.split('/').filter(Boolean).pop() ?? session.cwd
  return (
    <div
      className={`pane${enlarged ? ' enlarged' : ''}`}
      data-pane-id={session.id}
      data-status={session.status}
    >
      <div className="pane-header" onDoubleClick={onToggleEnlarge}>
        <span className="dot" />
        <span className="cwd" title={session.cwd}>
          {name}
        </span>
        <button onClick={onToggleEnlarge}>{enlarged ? 'shrink' : 'enlarge'}</button>
        <button onClick={onClose}>close</button>
      </div>
      {alive ? (
        <div className="term-host" ref={hostRef} />
      ) : (
        <div className="restart-overlay">
          {session.message && <p className="restart-message">{session.message}</p>}
          <button onClick={onRestart}>Restart (resume) session</button>
        </div>
      )}
    </div>
  )
}
