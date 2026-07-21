import { useEffect, useRef, useState } from 'react'
import type { AgentId, AgentInfo, SessionInfo } from '../../../shared/types'
import type { SessionTemplate } from '../../../shared/templates'
import type { FlowSummary } from '../../../shared/flows'
import { AGENT_PRESETS } from '../../../shared/agents'
import { normalizeHttpUrl } from '../../../shared/urls'
import { looksLikeTypedPath } from '../../../shared/paths'
import { deriveOverviewStats } from '../lib/overview-stats'
import { humanDuration } from '../lib/activity-format'
import ApproveButton from './ApproveButton'

// Same card look as Settings' agent-card (kept as a local literal — Landing
// and Settings are independent screens, not worth coupling over one class
// string).
const card =
  'bg-surface-raised flex flex-col gap-2.5 rounded-[10px] border border-white/10 p-3.5 text-left'

/** "claude + browser" — the template card's subtitle. */
function templateSummary(template: SessionTemplate): string {
  return template.panes
    .map((pane) => (pane.kind === 'browser' ? 'browser' : (pane.agentId ?? 'claude')))
    .join(' + ')
}

interface Props {
  sessions: SessionInfo[]
  onCreate: (agentId: AgentId, customCommand?: string, cwd?: string) => void
  onCreateBrowser: (url: string) => void
  onCreateTemplate: (name: string) => void
  /** Launches a saved flow (a "worker") through the engine via runFlow(id). */
  onLaunchWorker: (flowId: string) => void
  onOpen: (id: string) => void
  onResume: (id: string, fresh: boolean) => void
  onDelete: (id: string) => void
  onRename: (id: string, name: string) => void
  onChanges: (id: string) => void
  // Used by Task 4's "Configure in Settings" hint.
  onOpenSettings: () => void
  /** Jumps to the oldest waiting session (like cmd+u); wired to the "waiting Nm" chip. */
  onJumpToAttention: () => void
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
  onChanges,
  onOpenSettings,
  onCreateBrowser,
  onCreateTemplate,
  onLaunchWorker,
  onJumpToAttention
}: Props): React.JSX.Element {
  const [agents, setAgents] = useState<AgentInfo[] | null>(null)
  const [templates, setTemplates] = useState<SessionTemplate[] | null>(null)
  // A "worker" is a saved FlowGraph run by the engine — a launcher pseudo-value
  // alongside 'browser', NOT an AgentPreset (a worker is a graph, not a pty
  // binary). Its picker is fed by the existing listFlows IPC and launches via
  // the existing runFlow — zero new IPC.
  const [selectedAgentId, setSelectedAgentId] = useState<AgentId | 'browser' | 'worker'>(
    AGENT_PRESETS[0].id
  )
  const [workerFlows, setWorkerFlows] = useState<FlowSummary[] | null>(null)
  const [selectedWorkerId, setSelectedWorkerId] = useState('')
  // Async agent detection resolves a fallback default (below), but it must not
  // clobber a selection the user already made while detection was in flight.
  const userPickedAgent = useRef(false)
  const [urlInput, setUrlInput] = useState('')
  const [customCommand, setCustomCommand] = useState('')
  // Working-directory row for the New session launcher (path-input UX):
  // seeded from main's default-cwd resolution, editable when allowTypedPaths
  // is on, always overridable via the "Choose folder…" picker.
  const [cwd, setCwd] = useState('')
  const [allowTypedPaths, setAllowTypedPaths] = useState(false)
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
    void Promise.all([window.saiife.listAgents(), window.saiife.getLastAgent()]).then(
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
        // Precedence: configured default (if launchable) -> last-used ->
        // first resolved -> first preset. Custom is never a default.
        const defaultValid = list.find((a) => a.isDefault && a.resolvedPath)?.id
        const firstResolved = list.find((a) => a.resolvedPath)?.id
        const fallback = defaultValid ?? lastValid?.agentId ?? firstResolved ?? AGENT_PRESETS[0].id
        // Only seed the default if the user hasn't already picked an agent;
        // otherwise a late-resolving agent list would reset their choice.
        if (!userPickedAgent.current) setSelectedAgentId(fallback)
        if (lastValid?.agentId === 'custom') {
          setCustomCommand(lastValid.customCommand ?? '')
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [])

  // Separate from the agents fetch above: templates never touch
  // selectedAgentId/userPickedAgent, so this effect stays independent of
  // that selection state.
  useEffect(() => {
    let cancelled = false
    void window.saiife.listTemplates().then((list) => {
      if (!cancelled) setTemplates(list)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Lazily fetch saved flows the first time the user picks "Worker…" — keeps
  // the launcher list fresh without polling. Independent of agent detection.
  useEffect(() => {
    if (selectedAgentId !== 'worker') return
    let cancelled = false
    void window.saiife.listFlows().then((list) => {
      if (!cancelled) setWorkerFlows(list)
    })
    return () => {
      cancelled = true
    }
  }, [selectedAgentId])

  // Working-directory default + typed-paths toggle: also independent of the
  // agent-selection state above, fetched once on mount.
  useEffect(() => {
    let cancelled = false
    void window.saiife.getDefaultCwd().then((dir) => {
      if (!cancelled) setCwd(dir)
    })
    void window.saiife.getAllowTypedPaths().then((allow) => {
      if (!cancelled) setAllowTypedPaths(allow)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const chooseFolder = async (): Promise<void> => {
    const dir = await window.saiife.chooseFolder()
    if (dir) setCwd(dir)
  }

  const selectedAgent =
    selectedAgentId === 'browser' || selectedAgentId === 'worker'
      ? null
      : (agents?.find((a) => a.id === selectedAgentId) ?? null)
  // The typed cwd input only exists when allowTypedPaths is on, so its
  // validity only gates launch in that case — otherwise cwd always comes
  // from getDefaultCwd/chooseFolder, both of which are already valid.
  const cwdValid = selectedAgentId === 'browser' || !allowTypedPaths || looksLikeTypedPath(cwd)
  const launchable =
    (selectedAgentId === 'browser'
      ? normalizeHttpUrl(urlInput) !== null
      : selectedAgentId === 'worker'
        ? selectedWorkerId !== '' && (workerFlows?.some((f) => f.id === selectedWorkerId) ?? false)
        : selectedAgentId === 'custom'
          ? customCommand.trim().length > 0
          : !!selectedAgent?.resolvedPath) && cwdValid

  const create = (): void => {
    if (!launchable) return
    if (selectedAgentId === 'browser') {
      onCreateBrowser(normalizeHttpUrl(urlInput)!)
      return
    }
    if (selectedAgentId === 'worker') {
      onLaunchWorker(selectedWorkerId)
      return
    }
    onCreate(
      selectedAgentId,
      selectedAgentId === 'custom' ? customCommand.trim() : undefined,
      cwd.trim()
    )
  }

  // `now` powers the stats strip's "waiting Nm" span. Two lint rules rule out
  // the simplest options: react-hooks/purity forbids calling Date.now()
  // directly during render, and react-hooks/set-state-in-effect forbids
  // calling setState synchronously in an effect body (which piggybacking on
  // the `sessions` poll would require). A small 1s ticker — matching the
  // granularity humanDuration renders at, and the cadence of App's own
  // session poll — is the smallest fix that satisfies both.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [])
  const stats = deriveOverviewStats(sessions, now)

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
        <div className="overview-stats flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-gray-400">
          {stats.segments.map((seg, i) => (
            <span key={seg.status} className="flex items-center gap-2">
              {i > 0 && <span className="text-gray-600">·</span>}
              <span data-stat={seg.status}>
                <strong className="font-semibold text-gray-200">{seg.count}</strong> {seg.label}
              </span>
            </span>
          ))}
          {stats.oldestWaitMs !== null && (
            <button
              className="stats-waiting ml-1 cursor-pointer rounded border border-yellow-500/50 bg-yellow-500/10 px-2 py-0.5 text-yellow-300 hover:bg-yellow-500/20"
              onClick={onJumpToAttention}
              onMouseDown={(e) => e.preventDefault()}
            >
              waiting {humanDuration(stats.oldestWaitMs)}
            </button>
          )}
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
                      title={s.kind === 'browser' ? (s.url ?? '') : s.cwd}
                    >
                      {s.kind === 'browser' ? (s.url ?? '') : s.cwd}
                    </span>
                  </span>
                  <span className={`${paneAgent} w-[60px] text-center`}>
                    {s.kind === 'browser'
                      ? 'browser'
                      : s.agentId === 'custom'
                        ? s.command.split('/').pop()
                        : s.agentId}
                  </span>
                  <span
                    className="session-status w-[74px] text-right text-xs text-gray-400"
                    data-status={s.status}
                  >
                    {STATUS_LABEL[s.status]}
                  </span>
                  <span className="flex w-[280px] justify-end gap-1.5">
                    {s.kind !== 'browser' && (
                      <button
                        className={rowBtn}
                        onClick={() => onChanges(s.id)}
                        onMouseDown={(e) => e.preventDefault()}
                      >
                        changes
                      </button>
                    )}
                    {s.status === 'needs-you' && (
                      <ApproveButton
                        sessionId={s.id}
                        buttonClassName={`${rowBtnBase} border border-yellow-500/50 bg-yellow-500/10 px-2.5 text-yellow-300 hover:bg-yellow-500/20`}
                      />
                    )}
                    {s.status === 'exited' ? (
                      s.kind === 'browser' ? (
                        <button
                          className={rowBtn}
                          onClick={() => onResume(s.id, false)}
                          onMouseDown={(e) => e.preventDefault()}
                        >
                          reopen
                        </button>
                      ) : (
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
                      )
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
        {templates !== null && templates.length > 0 && (
          <div className="templates flex flex-wrap gap-2.5">
            {templates.map((t) => (
              <button
                key={t.name}
                className={`template-card ${card} cursor-pointer hover:bg-white/[0.03]`}
                onClick={() => onCreateTemplate(t.name)}
                onMouseDown={(e) => e.preventDefault()}
              >
                <span className="text-sm font-semibold">{t.name}</span>
                <span className="font-mono text-[11px] text-gray-500">{templateSummary(t)}</span>
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-col gap-2.5">
          <div className="flex gap-2.5">
            <select
              className="bg-surface-raised focus:border-working rounded-md border border-white/[0.14] px-2.5 py-2 text-[13px] text-gray-200 outline-none"
              value={selectedAgentId}
              onChange={(e) => {
                userPickedAgent.current = true
                setSelectedAgentId(e.target.value as AgentId | 'browser' | 'worker')
              }}
              aria-label="Agent"
            >
              {AGENT_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
              <option value="custom">Custom command…</option>
              <option value="browser">Browser…</option>
              <option value="worker">Worker…</option>
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
            {selectedAgentId === 'browser' && (
              <input
                className="url-input bg-surface focus:border-working flex-1 rounded-md border border-white/[0.14] px-2.5 py-2 font-mono text-xs text-gray-200 outline-none"
                placeholder="e.g. localhost:5173 or docs.anthropic.com"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && normalizeHttpUrl(urlInput) !== null) create()
                }}
              />
            )}
            {selectedAgentId === 'worker' && workerFlows !== null && workerFlows.length > 0 && (
              <select
                className="worker-select bg-surface-raised focus:border-working flex-1 rounded-md border border-white/[0.14] px-2.5 py-2 text-[13px] text-gray-200 outline-none"
                value={selectedWorkerId}
                onChange={(e) => setSelectedWorkerId(e.target.value)}
                aria-label="Worker"
              >
                <option value="">Choose a saved worker…</option>
                {workerFlows.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          {selectedAgentId === 'worker' && workerFlows !== null && workerFlows.length === 0 && (
            <p className="m-0 text-[13px] text-gray-500">
              No saved workers yet — build and save a flow in Flows, then launch it here.
            </p>
          )}
          {selectedAgentId !== 'browser' && (
            <div className="cwd-row flex items-center gap-2">
              {allowTypedPaths ? (
                <input
                  className="cwd-input bg-surface focus:border-working min-w-0 flex-1 rounded-md border border-white/[0.14] px-2.5 py-2 font-mono text-xs text-gray-200 outline-none"
                  placeholder="/path/to/project"
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && launchable) create()
                  }}
                />
              ) : (
                <span
                  className="cwd-display bg-surface min-w-0 flex-1 overflow-hidden rounded-md border border-white/[0.14] px-2.5 py-2 font-mono text-xs text-ellipsis whitespace-nowrap text-gray-400"
                  title={cwd}
                >
                  {cwd || 'Choosing a default…'}
                </span>
              )}
              <button
                className={rowBtn}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void chooseFolder()}
              >
                Choose folder…
              </button>
            </div>
          )}
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
          {selectedAgentId !== 'custom' &&
            selectedAgentId !== 'browser' &&
            agents !== null &&
            !selectedAgent?.resolvedPath && (
              <p className="m-0 text-[13px] text-gray-500">
                {selectedAgent?.label ?? selectedAgentId} isn&apos;t on your PATH — looked for
                &quot;{selectedAgent?.command}&quot;.{' '}
                <button
                  className="cursor-pointer border-0 bg-transparent p-0 text-[13px] text-gray-300 underline hover:text-white"
                  title="Set a path or install the agent from Settings → Agents"
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
