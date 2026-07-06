import { useEffect, useState } from 'react'
import type { AgentId, AgentInfo } from '../../../shared/types'

interface Props {
  onCreate: (agentId: AgentId, customCommand?: string) => void
}

const GHOST_LINES = [3, 4, 2]

export default function Landing({ onCreate }: Props): React.JSX.Element {
  const [agents, setAgents] = useState<AgentInfo[] | null>(null)
  const [customCommand, setCustomCommand] = useState('')

  useEffect(() => {
    let cancelled = false
    void window.localflow.listAgents().then((list) => {
      if (!cancelled) setAgents(list)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const setPath = async (agentId: AgentId): Promise<void> => {
    const updated = await window.localflow.setAgentPath(agentId)
    if (updated) setAgents(updated)
  }

  return (
    <div className="landing">
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
      <h2 className="empty-title">Every agent session, one window.</h2>
      <div className="agent-cards">
        {agents === null && <p className="empty-hint">Detecting installed agents…</p>}
        {agents?.map((agent) => (
          <div key={agent.id} className={`agent-card${agent.resolvedPath ? '' : ' missing'}`}>
            <div className="agent-card-head">
              <span className="agent-name">{agent.label}</span>
              {agent.hasStatusFeed && (
                <span className="agent-badge" title="Reports working / needs-you / done">
                  live status
                </span>
              )}
            </div>
            <div className="agent-detect" title={agent.resolvedPath ?? undefined}>
              {agent.resolvedPath ? (
                <>
                  <span className="detect-dot found" /> {agent.resolvedPath}
                </>
              ) : (
                <>
                  <span className="detect-dot" /> not found ({agent.command})
                </>
              )}
            </div>
            {agent.resolvedPath ? (
              <button
                className={agent.id === 'claude' ? 'new-session agent-start' : 'agent-start-alt'}
                onClick={() => onCreate(agent.id)}
              >
                New session
              </button>
            ) : (
              <button className="agent-start-alt" onClick={() => void setPath(agent.id)}>
                Set path…
              </button>
            )}
          </div>
        ))}
        {agents && (
          <div className="agent-card custom">
            <div className="agent-card-head">
              <span className="agent-name">Custom command</span>
            </div>
            <input
              className="agent-input"
              placeholder="e.g. aider"
              value={customCommand}
              onChange={(e) => setCustomCommand(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && customCommand.trim())
                  onCreate('custom', customCommand.trim())
              }}
            />
            <button
              className="agent-start-alt"
              disabled={!customCommand.trim()}
              onClick={() => onCreate('custom', customCommand.trim())}
            >
              New session
            </button>
          </div>
        )}
      </div>
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
        <span className="legend-item">
          <span className="legend-dot legend-running" /> running (no status feed)
        </span>
      </div>
    </div>
  )
}
