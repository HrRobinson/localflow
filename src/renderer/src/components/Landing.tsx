import { useEffect, useState } from 'react'
import type { AgentId, AgentInfo, SessionInfo } from '../../../shared/types'
import { AGENT_PRESETS } from '../../../shared/agents'

interface Props {
  sessions: SessionInfo[]
  onCreate: (agentId: AgentId, customCommand?: string) => void
  onOpen: (id: string) => void
  onResume: (id: string, fresh: boolean) => void
  onDelete: (id: string) => void
  onRename: (id: string, name: string) => void
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
  onDelete,
  onRename,
  onOpenSettings
}: Props): React.JSX.Element {
  const [agents, setAgents] = useState<AgentInfo[] | null>(null)
  const [selectedAgentId, setSelectedAgentId] = useState<AgentId>(AGENT_PRESETS[0].id)
  const [customCommand, setCustomCommand] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  // Clicking anywhere outside the armed row, or pressing Escape, disarms.
  // The Escape listener is local to the armed state — the global keyboard
  // dispatcher only claims bound combos, and bare Escape stays free.
  useEffect(() => {
    if (!confirmDeleteId) return
    const onDocMouseDown = (e: MouseEvent): void => {
      const row = (e.target as HTMLElement).closest(`[data-session-id="${confirmDeleteId}"]`)
      if (!row) setConfirmDeleteId(null)
    }
    const onDocKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) setConfirmDeleteId(null)
    }
    window.addEventListener('mousedown', onDocMouseDown)
    window.addEventListener('keydown', onDocKeyDown)
    return () => {
      window.removeEventListener('mousedown', onDocMouseDown)
      window.removeEventListener('keydown', onDocKeyDown)
    }
  }, [confirmDeleteId])

  // Defensive: if the session being edited or armed-for-delete disappears
  // from the list (deleted elsewhere, poll refresh), drop the stale state.
  // Render-time adjustment (not an effect) per React's "adjusting state when
  // props change" pattern — React re-renders immediately, before commit.
  if (editingId !== null && !sessions.some((s) => s.id === editingId)) setEditingId(null)
  if (confirmDeleteId !== null && !sessions.some((s) => s.id === confirmDeleteId)) {
    setConfirmDeleteId(null)
  }

  useEffect(() => {
    let cancelled = false
    void Promise.all([window.localflow.listAgents(), window.localflow.getLastAgent()]).then(
      ([list, last]) => {
        if (cancelled) return
        setAgents(list)
        // Fallback chain: last-used agent (if still launchable) -> first
        // resolved preset -> the first preset regardless of resolution.
        const lastValid =
          last &&
          (last.agentId === 'custom' || list.find((a) => a.id === last.agentId)?.resolvedPath)
            ? last
            : null
        const firstResolved = list.find((a) => a.resolvedPath)?.id
        const fallback = lastValid?.agentId ?? firstResolved ?? AGENT_PRESETS[0].id
        setSelectedAgentId(fallback)
        if (lastValid?.agentId === 'custom') {
          setCustomCommand(lastValid.customCommand ?? '')
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [])

  const selectedAgent = agents?.find((a) => a.id === selectedAgentId) ?? null
  const launchable =
    selectedAgentId === 'custom' ? customCommand.trim().length > 0 : !!selectedAgent?.resolvedPath

  const create = (): void => {
    if (!launchable) return
    onCreate(selectedAgentId, selectedAgentId === 'custom' ? customCommand.trim() : undefined)
  }

  return (
    <div className="landing mx-auto flex w-full max-w-[720px] flex-1 flex-col items-stretch gap-8 overflow-auto px-6 py-8 text-left">
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
        <section className="flex w-full flex-col items-stretch gap-3">
          <h3 className="m-0 text-[15px] font-semibold tracking-[-0.01em]">Latest sessions</h3>
          <div className="flex w-full flex-col gap-2">
            {sessions
              .slice(-5)
              .reverse()
              .map((s) => (
                <div
                  key={s.id}
                  className="session-row group bg-surface-raised flex items-center gap-3 rounded-[10px] border border-white/10 px-4 py-3 hover:bg-white/[0.03]"
                  data-session-id={s.id}
                >
                  <span
                    className="dot bg-exited h-2.5 w-2.5 flex-none rounded-full"
                    data-status={s.status}
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    {editingId === s.id ? (
                      <input
                        className="bg-surface -mx-1 -my-0.5 rounded border border-white/20 px-1 py-0.5 text-sm text-gray-100 outline-none"
                        value={editValue}
                        autoFocus
                        onFocus={(e) => e.currentTarget.select()}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            const trimmed = editValue.trim()
                            if (trimmed) {
                              onRename(s.id, trimmed)
                              setEditingId(null)
                            }
                            // Empty/whitespace: skip the commit and leave the
                            // input open so the user sees why nothing happened.
                          } else if (e.key === 'Escape') {
                            setEditingId(null)
                          }
                        }}
                        onBlur={() => setEditingId(null)}
                      />
                    ) : (
                      <span className="flex items-center gap-1.5">
                        <strong
                          className="cursor-text text-sm"
                          title="Double-click to rename"
                          onDoubleClick={() => {
                            setEditingId(s.id)
                            setEditValue(s.name)
                          }}
                        >
                          {s.name}
                        </strong>
                        <button
                          className="cursor-pointer border-0 bg-transparent p-0 text-xs text-gray-500 opacity-0 group-hover:opacity-100 hover:text-white"
                          title="Rename session"
                          onClick={() => {
                            setEditingId(s.id)
                            setEditValue(s.name)
                          }}
                          onMouseDown={(e) => e.preventDefault()}
                        >
                          ✎
                        </button>
                      </span>
                    )}
                    <span
                      className="overflow-hidden font-mono text-[11px] text-ellipsis whitespace-nowrap text-gray-500"
                      title={s.cwd}
                    >
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
                  <span className="flex w-[190px] justify-end gap-1.5">
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
                    {editingId !== s.id &&
                      (confirmDeleteId === s.id ? (
                        <>
                          <button
                            className={`${rowBtnBase} border border-red-500/60 bg-red-500/20 px-2 text-red-300 hover:bg-red-500/30`}
                            onClick={() => {
                              setConfirmDeleteId(null)
                              onDelete(s.id)
                            }}
                            onMouseDown={(e) => e.preventDefault()}
                          >
                            Delete
                          </button>
                          <button
                            className={`${rowBtnBase} ${rowBtnGray} px-2`}
                            onClick={() => setConfirmDeleteId(null)}
                            onMouseDown={(e) => e.preventDefault()}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          className={`${rowBtnBase} ${rowBtnGray} px-2 hover:text-red-400`}
                          title="Delete session"
                          onClick={() => setConfirmDeleteId(s.id)}
                          onMouseDown={(e) => e.preventDefault()}
                        >
                          ×
                        </button>
                      ))}
                  </span>
                </div>
              ))}
          </div>
        </section>
      )}
      <section className="flex w-full flex-col items-stretch gap-3">
        <h3 className="m-0 text-[15px] font-semibold tracking-[-0.01em]">New session</h3>
        <div className="flex flex-col gap-2.5">
          <div className="flex gap-2.5">
            <select
              className="bg-surface-raised focus:border-working rounded-md border border-white/[0.14] px-2.5 py-2 text-[13px] text-gray-200 outline-none"
              value={selectedAgentId}
              onChange={(e) => setSelectedAgentId(e.target.value as AgentId)}
              aria-label="Agent"
            >
              {AGENT_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
              <option value="custom">Custom command…</option>
            </select>
            {selectedAgentId === 'custom' && (
              <input
                className="bg-surface focus:border-working flex-1 rounded-md border border-white/[0.14] px-2.5 py-2 font-mono text-xs text-gray-200 outline-none"
                placeholder="e.g. aider"
                value={customCommand}
                onChange={(e) => setCustomCommand(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && customCommand.trim()) create()
                }}
              />
            )}
          </div>
          <button
            className="new-session w-full cursor-pointer rounded-md border-0 bg-blue-600 py-2 text-center text-[13px] text-white disabled:cursor-default disabled:opacity-[0.45]"
            disabled={!launchable}
            onClick={create}
            onMouseDown={(e) => e.preventDefault()}
          >
            New session
          </button>
          {agents === null && (
            <p className="m-0 text-[13px] text-gray-500">Detecting installed agents…</p>
          )}
          {selectedAgentId !== 'custom' && agents !== null && !selectedAgent?.resolvedPath && (
            <p className="m-0 text-[13px] text-gray-500">
              {selectedAgent?.label ?? selectedAgentId} not found ({selectedAgent?.command}).{' '}
              <button
                className="cursor-pointer border-0 bg-transparent p-0 text-[13px] text-gray-300 underline hover:text-white"
                onClick={onOpenSettings}
                onMouseDown={(e) => e.preventDefault()}
              >
                Configure in Settings
              </button>
            </p>
          )}
        </div>
      </section>
    </div>
  )
}
