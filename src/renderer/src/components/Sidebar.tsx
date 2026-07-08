import { useEffect, useState } from 'react'
import Brand from './Brand'
import { visibleWorkspaces, worstStatus } from '../../../shared/workspace'
import type { SessionInfo } from '../../../shared/types'

interface Props {
  sessions: SessionInfo[]
  view: 'home' | 'terminals' | 'settings'
  activeId: string | null
  workspace: number
  onSwitchWorkspace: (n: number) => void
  onHome: () => void
  onTerminals: () => void
  onSettings: () => void
  onOpenSession: (id: string) => void
  onDeleteSession: (id: string) => void
  onRenameSession: (id: string, name: string) => void
}

const navItemBase =
  'cursor-pointer rounded-md border-0 bg-transparent px-2.5 py-[7px] text-left text-[13px] text-gray-400 hover:bg-white/5 hover:text-white disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-gray-400'
const navItemActive = 'bg-white/[0.08] font-semibold text-white'

export default function Sidebar({
  sessions,
  view,
  activeId,
  workspace,
  onSwitchWorkspace,
  onHome,
  onTerminals,
  onSettings,
  onOpenSession,
  onDeleteSession,
  onRenameSession
}: Props): React.JSX.Element {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [wsNames, setWsNames] = useState<Record<string, string>>({})
  useEffect(() => {
    let cancelled = false
    void window.localflow.getWorkspaceNames().then((names) => {
      if (!cancelled) setWsNames(names)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Clicking anywhere outside the armed row, or pressing Escape, disarms.
  // The Escape listener is local to the armed state — the global keyboard
  // dispatcher only claims bound combos, and bare Escape stays free.
  useEffect(() => {
    if (!confirmDeleteId) return
    const onDocMouseDown = (e: MouseEvent): void => {
      const row = (e.target as HTMLElement).closest(`[data-nav-session="${confirmDeleteId}"]`)
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

  return (
    <aside className="bg-sidebar flex min-h-0 w-[230px] flex-none flex-col border-r border-white/[0.07]">
      <div className="flex items-center gap-[9px] px-4 pt-4 pb-2.5">
        <Brand />
        <span className="font-mono text-[13px] font-semibold tracking-[0.02em] text-gray-200">
          localflow
        </span>
      </div>
      <nav className="flex flex-col gap-0.5 p-2">
        <button
          className={`${navItemBase}${view === 'home' ? ` ${navItemActive}` : ''}`}
          onClick={onHome}
          onMouseDown={(e) => e.preventDefault()}
        >
          Overview
        </button>
        <button
          className={`${navItemBase}${view === 'terminals' ? ` ${navItemActive}` : ''}`}
          onClick={onTerminals}
          disabled={sessions.length === 0}
          onMouseDown={(e) => e.preventDefault()}
        >
          Terminals
        </button>
        <button
          className={`${navItemBase}${view === 'settings' ? ` ${navItemActive}` : ''}`}
          onClick={onSettings}
          onMouseDown={(e) => e.preventDefault()}
        >
          Settings
        </button>
      </nav>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        <div className="px-2.5 pt-2 pb-1 text-[11px] tracking-[0.06em] text-gray-500 uppercase">
          Workspaces
        </div>
        {visibleWorkspaces(sessions, workspace).map((n) => {
          const wsSessions = sessions.filter((s) => s.workspace === n)
          return (
            <div key={n}>
              <button
                className={`flex w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2.5 py-1.5 text-left text-[12px] ${
                  n === workspace
                    ? 'font-semibold text-white'
                    : 'text-gray-400 hover:bg-white/5 hover:text-white'
                }`}
                data-nav-workspace={n}
                onClick={() => onSwitchWorkspace(n)}
                onMouseDown={(e) => e.preventDefault()}
              >
                <span
                  className="dot bg-exited h-2 w-2 flex-none rounded-full"
                  data-status={worstStatus(wsSessions.map((s) => s.status))}
                />
                <span className="flex-1">
                  {n}
                  {wsNames[String(n)] ? ` · ${wsNames[String(n)]}` : ''}
                </span>
                <span className="text-[11px] text-gray-600">{wsSessions.length || ''}</span>
              </button>
              {wsSessions.map((s) => (
                <div
                  key={s.id}
                  className={`side-session group flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 pl-2 text-[13px] text-gray-300 hover:bg-white/5 hover:text-white ${activeId === s.id && view === 'terminals' ? 'active bg-white/10 text-white' : ''}`}
                  data-nav-session={s.id}
                >
                  <span
                    className="dot bg-exited h-2 w-2 flex-none rounded-full"
                    data-status={s.status}
                  />
                  {editingId === s.id ? (
                    <input
                      className="bg-surface min-w-0 flex-1 rounded border border-white/20 px-1 py-0 text-[13px] text-gray-100 outline-none"
                      value={editValue}
                      autoFocus
                      onFocus={(e) => e.currentTarget.select()}
                      onChange={(e) => setEditValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          const trimmed = editValue.trim()
                          if (trimmed) {
                            onRenameSession(s.id, trimmed)
                            setEditingId(null)
                          }
                          // Empty/whitespace: skip the commit and leave the input
                          // open so the user sees why nothing happened.
                        } else if (e.key === 'Escape') {
                          setEditingId(null)
                        }
                      }}
                      onBlur={() => setEditingId(null)}
                    />
                  ) : (
                    <>
                      <button
                        className="min-w-0 flex-1 cursor-pointer overflow-hidden border-0 bg-transparent p-0 text-left text-ellipsis whitespace-nowrap text-inherit"
                        title={s.cwd}
                        onClick={() => onOpenSession(s.id)}
                        onMouseDown={(e) => e.preventDefault()}
                      >
                        {s.name}
                      </button>
                      {/* Rename gets its own button (not dblclick on the name):
                          browsers fire two clicks before dblclick, so a dblclick
                          rename on the open button would first open/enlarge the
                          session and race the rename input for focus. */}
                      <button
                        className="flex-none cursor-pointer border-0 bg-transparent p-0 text-xs text-gray-500 opacity-0 group-hover:opacity-100 hover:text-white"
                        title="Rename session"
                        onClick={(e) => {
                          e.stopPropagation()
                          setEditingId(s.id)
                          setEditValue(s.name)
                        }}
                        onMouseDown={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                        }}
                      >
                        ✎
                      </button>
                    </>
                  )}
                  {editingId !== s.id &&
                    (confirmDeleteId === s.id ? (
                      <span className="flex flex-none gap-1">
                        <button
                          className="cursor-pointer rounded border-0 bg-red-500/20 px-1.5 text-[11px] text-red-300 hover:bg-red-500/30"
                          onClick={() => {
                            setConfirmDeleteId(null)
                            onDeleteSession(s.id)
                          }}
                          onMouseDown={(e) => e.preventDefault()}
                        >
                          Delete
                        </button>
                        <button
                          className="cursor-pointer rounded border-0 bg-white/10 px-1.5 text-[11px] text-gray-300 hover:bg-white/20"
                          onClick={() => setConfirmDeleteId(null)}
                          onMouseDown={(e) => e.preventDefault()}
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        className="cursor-pointer border-0 bg-transparent p-0 text-xs text-gray-500 opacity-0 group-hover:opacity-100 hover:text-red-400"
                        title="Delete session"
                        onClick={() => setConfirmDeleteId(s.id)}
                        onMouseDown={(e) => e.preventDefault()}
                      >
                        ×
                      </button>
                    ))}
                </div>
              ))}
            </div>
          )
        })}
        {sessions.length === 0 && (
          <div className="px-2.5 py-0.5 text-xs text-gray-600">none yet</div>
        )}
        <button
          className="block w-full cursor-pointer rounded-md border-0 bg-transparent px-2.5 py-1.5 text-left text-[13px] text-gray-500 hover:bg-white/5 hover:text-gray-300"
          onClick={onHome}
          onMouseDown={(e) => e.preventDefault()}
        >
          + new session
        </button>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1.5 border-t border-white/[0.07] px-4 py-3 text-[11px] text-gray-400">
        <span className="flex items-center gap-1.5">
          <span className="bg-working h-[9px] w-[9px] rounded-full" /> working
        </span>
        <span className="flex items-center gap-1.5">
          <span className="bg-needs-you h-[9px] w-[9px] rounded-full" /> needs you
        </span>
        <span className="flex items-center gap-1.5">
          <span className="bg-idle h-[9px] w-[9px] rounded-full" /> done
        </span>
        <span className="flex items-center gap-1.5">
          <span className="bg-running h-[9px] w-[9px] rounded-full" /> running
        </span>
      </div>
    </aside>
  )
}
