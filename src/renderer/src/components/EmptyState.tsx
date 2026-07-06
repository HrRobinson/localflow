interface Props {
  onCreate: () => void
}

const GHOST_LINES = [3, 4, 2]

export default function EmptyState({ onCreate }: Props): React.JSX.Element {
  return (
    <div className="empty-state">
      <div className="ghost-grid" aria-hidden="true">
        {GHOST_LINES.map((lines, pane) => (
          <div key={pane} className="ghost-pane">
            <div className="ghost-header">
              <span className="ghost-dot" />
              <span className="ghost-title" />
            </div>
            <div className="ghost-body">
              {Array.from({ length: lines }, (_, i) => (
                <span key={i} className="ghost-line" />
              ))}
            </div>
          </div>
        ))}
      </div>
      <h2 className="empty-title">Every Claude session, one window.</h2>
      <button className="new-session empty-cta" onClick={onCreate}>
        + New session
      </button>
      <p className="empty-hint">Pick a project folder to start.</p>
      <div className="empty-legend">
        <span className="legend-item">
          <span className="legend-dot legend-working" /> working
        </span>
        <span className="legend-item">
          <span className="legend-dot legend-needs-you" /> needs you
        </span>
        <span className="legend-item">
          <span className="legend-dot legend-idle" /> done
        </span>
      </div>
    </div>
  )
}
