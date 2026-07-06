import { useEffect, useState } from 'react'
import type { AgentId, AgentInfo, SessionInfo } from '../../../shared/types'

interface Props {
  sessions: SessionInfo[]
  onCreate: (agentId: AgentId, customCommand?: string) => void
  onOpen: (id: string) => void
  onResume: (id: string, fresh: boolean) => void
  onRemove: (id: string) => void
}

const GHOST_LINES = [3, 4, 2]

const STATUS_LABEL: Record<SessionInfo['status'], string> = {
  idle: 'done',
  working: 'working',
  'needs-you': 'needs you',
  running: 'running',
  exited: 'exited'
}

export default function Landing({
  sessions,
  onCreate,
  onOpen,
  onResume,
  onRemove
}: Props): React.JSX.Element {
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

  const projectName = (cwd: string): string => cwd.split('/').filter(Boolean).pop() ?? cwd

  return (
    <div className="landing">
      {sessions.length === 0 && (
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
      )}
      {sessions.length > 0 && (
        <section className="home-section">
          <h3 className="home-heading">Sessions</h3>
          <div className="session-table">
            <div className="session-thead">
              <span className="thead-project">Project</span>
              <span className="thead-agent">Agent</span>
              <span className="thead-status">Status</span>
              <span className="thead-actions" />
            </div>
            {sessions.map((s) => (
              <div key={s.id} className="session-row" data-session-id={s.id}>
                <span className="dot" data-status={s.status} />
                <span className="session-project" title={s.cwd}>
                  <strong>{projectName(s.cwd)}</strong>
                  <span className="session-path">{s.cwd}</span>
                </span>
                <span className="pane-agent">
                  {s.agentId === 'custom' ? s.command.split('/').pop() : s.agentId}
                </span>
                <span className="session-status" data-status={s.status}>
                  {STATUS_LABEL[s.status]}
                </span>
                <span className="session-actions">
                  {s.status === 'exited' ? (
                    <>
                      <button className="row-btn" onClick={() => onResume(s.id, false)}>
                        resume
                      </button>
                      <button className="row-btn" onClick={() => onResume(s.id, true)}>
                        fresh
                      </button>
                    </>
                  ) : (
                    <button className="row-btn row-open" onClick={() => onOpen(s.id)}>
                      open
                    </button>
                  )}
                  <button
                    className="row-btn row-remove"
                    title="Remove session"
                    onClick={() => onRemove(s.id)}
                  >
                    ×
                  </button>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
      <section className="home-section">
        <h3 className="home-heading">
          {sessions.length > 0 ? 'Start another session' : 'Every agent session, one window.'}
        </h3>
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
      </section>
    </div>
  )
}
