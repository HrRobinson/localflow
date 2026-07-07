import { useEffect, useState } from 'react'
import type { AgentId, AgentInfo, SessionInfo } from '../../../shared/types'

interface Props {
  sessions: SessionInfo[]
  onCreate: (agentId: AgentId, customCommand?: string) => void
  onOpen: (id: string) => void
  onResume: (id: string, fresh: boolean) => void
  onRemove: (id: string) => void
  // Used by Task 4's "Configure in Settings" hint.
  onOpenSettings: () => void
}

const GHOST_LINES = [3, 4, 2]

const STATUS_LABEL: Record<SessionInfo['status'], string> = {
  idle: 'done',
  working: 'working',
  'needs-you': 'needs you',
  running: 'running',
  exited: 'exited'
}

const agentStartAlt =
  'w-full cursor-pointer rounded-md border border-white/[0.12] bg-white/[0.08] py-2 text-center text-[13px] text-gray-200 hover:bg-white/[0.14] disabled:cursor-default disabled:opacity-[0.45] disabled:hover:bg-white/[0.08]'
const rowBtnBase = 'cursor-pointer rounded-md py-1 text-xs'
const rowBtnGray =
  'border border-white/10 bg-white/[0.07] text-gray-300 hover:bg-white/[0.13] hover:text-white'
const rowBtn = `${rowBtnBase} ${rowBtnGray} px-2.5`
const paneAgent = 'rounded bg-white/[0.06] px-1.5 py-px font-mono text-[10px] text-gray-400'

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
    <div className="landing flex flex-1 flex-col items-stretch gap-7 overflow-auto px-6 py-5 text-left">
      {sessions.length === 0 && (
        <div className="ghost-grid mx-0 mt-10 mb-2.5 flex gap-3.5 self-center" aria-hidden="true">
          {GHOST_LINES.map((lines, pane) => (
            <div key={pane} className="ghost-pane">
              <div className="ghost-header flex items-center gap-1.5 bg-white/[0.04] px-2 py-1.5">
                <span className="ghost-dot" />
                <span className="ghost-title h-1.5 w-[46px] rounded-[3px] bg-white/[0.14]" />
              </div>
              <div className="ghost-body flex flex-col gap-[7px] p-2.5">
                {Array.from({ length: lines }, (_, i) => (
                  <span key={i} className="ghost-line" />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {sessions.length > 0 && (
        <section className="home-section flex w-full max-w-[960px] flex-col items-stretch gap-3">
          <h3 className="m-0 text-[15px] font-semibold tracking-[-0.01em]">Sessions</h3>
          <div className="session-table bg-surface-raised flex w-full flex-col divide-y divide-white/[0.07] overflow-hidden rounded-[10px] border border-white/10 text-left">
            <div className="flex items-center gap-3 bg-white/[0.02] px-3.5 py-2 text-[11px] tracking-[0.06em] text-gray-500 uppercase">
              <span className="flex-1 pl-[22px]">Project</span>
              <span className="w-[60px]">Agent</span>
              <span className="w-[74px] text-right">Status</span>
              <span className="w-[150px]" />
            </div>
            {sessions.map((s) => (
              <div
                key={s.id}
                className="session-row flex items-center gap-3 px-3.5 py-2.5 hover:bg-white/[0.03]"
                data-session-id={s.id}
              >
                <span
                  className="dot bg-exited h-2.5 w-2.5 flex-none rounded-full"
                  data-status={s.status}
                />
                <span
                  className="flex min-w-0 flex-1 items-baseline gap-2.5 text-[13px]"
                  title={s.cwd}
                >
                  <strong>{projectName(s.cwd)}</strong>
                  <span className="overflow-hidden font-mono text-[11px] text-ellipsis whitespace-nowrap text-gray-500">
                    {s.cwd}
                  </span>
                </span>
                <span className={`${paneAgent} w-[60px] text-center`}>
                  {s.agentId === 'custom' ? s.command.split('/').pop() : s.agentId}
                </span>
                <span
                  className="session-status w-[74px] text-right text-xs text-gray-400"
                  data-status={s.status}
                >
                  {STATUS_LABEL[s.status]}
                </span>
                <span className="flex w-[150px] justify-end gap-1.5">
                  {s.status === 'exited' ? (
                    <>
                      <button
                        className={rowBtn}
                        onClick={() => onResume(s.id, false)}
                        onMouseDown={(e) => e.preventDefault()}
                      >
                        resume
                      </button>
                      <button
                        className={rowBtn}
                        onClick={() => onResume(s.id, true)}
                        onMouseDown={(e) => e.preventDefault()}
                      >
                        fresh
                      </button>
                    </>
                  ) : (
                    <button
                      className={`row-open ${rowBtnBase} border border-blue-600 bg-blue-600 px-2.5 text-white hover:bg-blue-700`}
                      onClick={() => onOpen(s.id)}
                      onMouseDown={(e) => e.preventDefault()}
                    >
                      open
                    </button>
                  )}
                  <button
                    className={`${rowBtnBase} ${rowBtnGray} px-2`}
                    title="Remove session"
                    onClick={() => onRemove(s.id)}
                    onMouseDown={(e) => e.preventDefault()}
                  >
                    ×
                  </button>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
      <section className="home-section flex w-full max-w-[960px] flex-col items-stretch gap-3">
        <h3 className="m-0 text-[15px] font-semibold tracking-[-0.01em]">
          {sessions.length > 0 ? 'Start another session' : 'Every agent session, one window.'}
        </h3>
        <div className="flex flex-wrap justify-start gap-3.5">
          {agents === null && (
            <p className="m-0 text-[13px] text-gray-400">Detecting installed agents…</p>
          )}
          {agents?.map((agent) => (
            <div
              key={agent.id}
              className={`bg-surface-raised flex w-[220px] flex-col gap-2.5 rounded-[10px] border border-white/10 p-3.5 text-left ${agent.resolvedPath ? '' : 'opacity-75'}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold">{agent.label}</span>
                {agent.hasStatusFeed && (
                  <span
                    className="border-idle/50 text-idle rounded-full border px-2 py-px text-[10px] whitespace-nowrap"
                    title="Reports working / needs-you / done"
                  >
                    live status
                  </span>
                )}
              </div>
              <div
                className="flex items-center gap-1.5 overflow-hidden font-mono text-[11px] text-ellipsis whitespace-nowrap text-gray-400"
                title={agent.resolvedPath ?? undefined}
              >
                {agent.resolvedPath ? (
                  <>
                    <span className="bg-idle h-2 w-2 flex-none rounded-full" /> {agent.resolvedPath}
                  </>
                ) : (
                  <>
                    <span className="bg-exited h-2 w-2 flex-none rounded-full" /> not found (
                    {agent.command})
                  </>
                )}
              </div>
              {agent.resolvedPath ? (
                <button
                  className={
                    agent.id === 'claude'
                      ? 'new-session w-full cursor-pointer rounded-md border-0 bg-blue-600 py-2 text-center text-[13px] text-white'
                      : agentStartAlt
                  }
                  onClick={() => onCreate(agent.id)}
                  onMouseDown={(e) => e.preventDefault()}
                >
                  New session
                </button>
              ) : (
                <button
                  className={agentStartAlt}
                  onClick={() => void setPath(agent.id)}
                  onMouseDown={(e) => e.preventDefault()}
                >
                  Set path…
                </button>
              )}
            </div>
          ))}
          {agents && (
            <div className="bg-surface-raised flex w-[220px] flex-col gap-2.5 rounded-[10px] border border-white/10 p-3.5 text-left">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold">Custom command</span>
              </div>
              <input
                className="bg-surface focus:border-working rounded-md border border-white/[0.14] px-2.5 py-2 font-mono text-xs text-gray-200 outline-none"
                placeholder="e.g. aider"
                value={customCommand}
                onChange={(e) => setCustomCommand(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && customCommand.trim())
                    onCreate('custom', customCommand.trim())
                }}
              />
              <button
                className={agentStartAlt}
                disabled={!customCommand.trim()}
                onClick={() => onCreate('custom', customCommand.trim())}
                onMouseDown={(e) => e.preventDefault()}
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
