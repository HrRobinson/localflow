import Brand from './Brand'
import type { SessionInfo } from '../../../shared/types'

interface Props {
  sessions: SessionInfo[]
  view: 'home' | 'terminals'
  activeSession: string | null
  onHome: () => void
  onTerminals: () => void
  onOpenSession: (id: string) => void
}

export default function Sidebar({
  sessions,
  view,
  activeSession,
  onHome,
  onTerminals,
  onOpenSession
}: Props): React.JSX.Element {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <Brand />
        <span className="sidebar-title">localflow</span>
      </div>
      <nav className="sidebar-nav">
        <button className={`nav-item${view === 'home' ? ' active' : ''}`} onClick={onHome}>
          Overview
        </button>
        <button
          className={`nav-item${view === 'terminals' ? ' active' : ''}`}
          onClick={onTerminals}
          disabled={sessions.length === 0}
        >
          Terminals
        </button>
      </nav>
      <div className="sidebar-section">
        <div className="sidebar-heading">Sessions</div>
        {sessions.length === 0 && <div className="sidebar-empty">none yet</div>}
        {sessions.map((s) => (
          <button
            key={s.id}
            className={`side-session${activeSession === s.id && view === 'terminals' ? ' active' : ''}`}
            data-nav-session={s.id}
            title={s.cwd}
            onClick={() => onOpenSession(s.id)}
          >
            <span className="dot" data-status={s.status} />
            <span className="side-session-name">
              {s.cwd.split('/').filter(Boolean).pop() ?? s.cwd}
            </span>
          </button>
        ))}
        <button className="side-new" onClick={onHome}>
          + new session
        </button>
      </div>
      <div className="sidebar-footer">
        <span className="legend-item">
          <span className="legend-dot legend-working" /> working
        </span>
        <span className="legend-item">
          <span className="legend-dot legend-needs-you" /> needs you
        </span>
        <span className="legend-item">
          <span className="legend-dot legend-idle" /> done
        </span>
        <span className="legend-item">
          <span className="legend-dot legend-running" /> running
        </span>
      </div>
    </aside>
  )
}
