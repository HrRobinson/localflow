import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionInfo } from '../../../shared/types'
import type { Capabilities, DiffResult, GitFileEntry, GitStatus } from '../../../shared/git'
import { classifyDiffLine } from '../../../shared/git'

interface Props {
  sessions: SessionInfo[]
  sessionId: string | null
  onSelectSession: (id: string) => void
  /** Main spawns the lazygit session; App navigates to it. */
  onOpenLazygit: (sessionId: string) => void
}

// Slower than the app's 1s session poll (see justification in the effect below).
const CHANGES_POLL_MS = 2000

function Badges({ entry }: { entry: GitFileEntry }): React.JSX.Element {
  return (
    <span className="flex flex-none gap-1 text-[10px]">
      {entry.staged && <span className="badge-staged">staged</span>}
      {entry.unstaged && <span className="badge-unstaged">unstaged</span>}
      {entry.untracked && <span className="badge-untracked">untracked</span>}
    </span>
  )
}

/**
 * Read-only diff review scoped to one session. Left: the porcelain file list
 * with staged/unstaged/untracked badges. Right: the selected file's merged diff
 * (staged + unstaged layers concatenated; untracked arrives as a full addition
 * from main). Diff-level coloring only. `j`/`k` move the selection via a
 * view-local listener — bare letters, never a global binding, so terminals
 * elsewhere lose no keystrokes.
 */
export default function Changes({
  sessions,
  sessionId,
  onSelectSession,
  onOpenLazygit
}: Props): React.JSX.Element {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [statusError, setStatusError] = useState(false)
  const [caps, setCaps] = useState<Capabilities | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [diff, setDiff] = useState<DiffResult | null>(null)
  const [diffError, setDiffError] = useState(false)

  const files: GitFileEntry[] = status?.repo ? status.files : []
  const activeSession = sessions.find((s) => s.id === sessionId) ?? null
  const isBrowser = activeSession?.kind === 'browser'
  const terminalSessions = sessions.filter((s) => s.kind !== 'browser')

  // Latest-request guards: a quick session/file switch must not let a slow
  // earlier response overwrite a newer one.
  const statusReq = useRef(0)
  const diffReq = useRef(0)

  const loadStatus = useCallback(async (id: string | null): Promise<void> => {
    const req = ++statusReq.current
    if (!id) {
      setStatus({ repo: false })
      setStatusError(false)
      return
    }
    try {
      const s = await window.localflow.gitStatus(id)
      if (statusReq.current === req) {
        setStatus(s)
        setStatusError(false)
      }
    } catch {
      // A failed fetch must never be mistaken for a clean tree: keep status
      // null but flip a distinct error flag so the empty-state copy can tell
      // "we don't know" apart from "we checked and there's nothing".
      if (statusReq.current === req) {
        setStatus(null)
        setStatusError(true)
      }
    }
  }, [])

  const loadDiff = useCallback(
    async (id: string, entry: GitFileEntry | undefined): Promise<void> => {
      const req = ++diffReq.current
      if (!entry) {
        setDiff(null)
        setDiffError(false)
        return
      }
      try {
        const parts: string[] = []
        let truncated = false
        // Staged layer first (git's own ordering), then the worktree layer —
        // which also produces the untracked full-addition via main's fallback.
        if (entry.staged) {
          const d = await window.localflow.gitDiff(id, entry.path, true)
          if (d.text) parts.push(d.text)
          truncated = truncated || d.truncated
        }
        if (entry.unstaged || entry.untracked) {
          const d = await window.localflow.gitDiff(id, entry.path, false)
          if (d.text) parts.push(d.text)
          truncated = truncated || d.truncated
        }
        if (diffReq.current === req) {
          setDiff({ text: parts.join('\n'), truncated })
          setDiffError(false)
        }
      } catch {
        if (diffReq.current === req) {
          setDiff(null)
          setDiffError(true)
        }
      }
    },
    []
  )

  // (Re)load whenever the reviewed session changes: reset selection, refetch
  // status + capabilities.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting selection is the point of this effect: the session identity changed
    setSelectedPath(null)
    setDiff(null)
    setDiffError(false)
    // Invalidate any in-flight diff request from the previous session/file.
    // Without this, a slow response for the old selection can still land
    // after selectedPath/diff are cleared and a new file gets picked in the
    // new session — its guard (diffReq.current === req) would pass and
    // repopulate `diff` with the stale file's content under the new label.
    diffReq.current++
    void loadStatus(sessionId)
    void window.localflow.getCapabilities().then(setCaps)
  }, [sessionId, loadStatus])

  // Cheap poll while visible: refresh the file LIST only (never the open diff —
  // refetching would reset the user's scroll). 2s, not the app's 1s session
  // cadence: git status spawns a subprocess and walks the worktree, and review
  // changes come from an agent editing files, so sub-2s freshness is
  // imperceptible and not worth doubling the process-spawn rate.
  useEffect(() => {
    if (!sessionId) return
    const iv = setInterval(() => void loadStatus(sessionId), CHANGES_POLL_MS)
    return () => clearInterval(iv)
  }, [sessionId, loadStatus])

  // Drop a selection that vanished from the refreshed list.
  useEffect(() => {
    if (selectedPath !== null && !files.some((f) => f.path === selectedPath)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing local selection to the external file list from main
      setSelectedPath(null)
      setDiff(null)
    }
  }, [files, selectedPath])

  const select = useCallback(
    (path: string): void => {
      setSelectedPath(path)
      if (sessionId)
        void loadDiff(
          sessionId,
          files.find((f) => f.path === path)
        )
    },
    [sessionId, files, loadDiff]
  )

  // View-local j/k file navigation. Mounted only while this view is open, so
  // bare letters never leak into a terminal elsewhere. Ignores modified combos
  // and events targeting form controls (the session switcher).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key !== 'j' && e.key !== 'k') return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      if (files.length === 0) return
      e.preventDefault()
      const cur = selectedPath === null ? -1 : files.findIndex((f) => f.path === selectedPath)
      const next = e.key === 'j' ? Math.min(cur + 1, files.length - 1) : Math.max(cur - 1, 0)
      const target = files[next < 0 ? 0 : next]
      if (target) select(target.path)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [files, selectedPath, select])

  const refresh = (): void => {
    if (!sessionId) return
    void loadStatus(sessionId)
    if (selectedPath)
      void loadDiff(
        sessionId,
        files.find((f) => f.path === selectedPath)
      )
    void window.localflow.getCapabilities().then(setCaps)
  }

  const empty =
    sessionId === null ||
    isBrowser ||
    status === null ||
    status.repo === false ||
    files.length === 0

  const emptyMessage =
    sessionId === null
      ? 'No repository session selected.'
      : isBrowser
        ? 'Browser panes have no working tree.'
        : statusError
          ? "Couldn't load changes for this session."
          : status?.repo === false
            ? "This session's folder isn't a git repository."
            : 'No changes — the working tree is clean.'

  const btn =
    'cursor-pointer rounded-md border border-white/10 bg-white/[0.07] px-2.5 py-1 text-gray-300 hover:bg-white/[0.13] hover:text-white disabled:cursor-default disabled:opacity-40 disabled:hover:bg-white/[0.07] disabled:hover:text-gray-300'

  return (
    <div className="changes-view flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none items-center gap-2 border-b border-white/[0.07] px-3 py-2 text-[12px]">
        <select
          className="changes-session-select bg-surface-raised rounded-md border border-white/[0.14] px-2 py-1 text-gray-200 outline-none"
          value={sessionId ?? ''}
          onChange={(e) => onSelectSession(e.target.value)}
          aria-label="Session"
        >
          {terminalSessions.length === 0 && <option value="">(no repository sessions)</option>}
          {terminalSessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <button
          className={`changes-refresh ${btn}`}
          onClick={refresh}
          onMouseDown={(e) => e.preventDefault()}
        >
          Refresh
        </button>
        <span className="flex-1" />
        <button
          className={`open-lazygit ${btn}`}
          disabled={!sessionId || isBrowser || !caps?.lazygit.available}
          title={
            caps && !caps.lazygit.available ? caps.lazygit.hint : 'Open lazygit in this folder'
          }
          onClick={() => sessionId && onOpenLazygit(sessionId)}
          onMouseDown={(e) => e.preventDefault()}
        >
          Open lazygit here
        </button>
        <button
          className={`open-editor ${btn}`}
          disabled={!sessionId || isBrowser || !caps?.editor.available}
          title={
            caps && !caps.editor.available
              ? caps.editor.hint
              : `Open in ${caps?.editor.command ?? 'editor'}`
          }
          onClick={() => sessionId && void window.localflow.openEditor(sessionId)}
          onMouseDown={(e) => e.preventDefault()}
        >
          Open in editor
        </button>
      </div>
      {empty ? (
        <div className="changes-empty flex flex-1 flex-col items-center justify-center px-6 text-center text-[13px] text-gray-500">
          {emptyMessage}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="w-[280px] flex-none overflow-auto border-r border-white/[0.07] py-1">
            {files.map((f) => (
              <button
                key={f.path}
                className={`changes-file flex w-full items-center gap-2 border-0 bg-transparent px-3 py-1.5 text-left text-[12px] text-gray-300 hover:bg-white/5 ${
                  selectedPath === f.path ? 'active text-white' : ''
                }`}
                data-path={f.path}
                onClick={() => select(f.path)}
                onMouseDown={(e) => e.preventDefault()}
              >
                <span className="min-w-0 flex-1 overflow-hidden font-mono text-ellipsis whitespace-nowrap">
                  {f.path}
                </span>
                <Badges entry={f} />
              </button>
            ))}
          </div>
          <div className="changes-diff min-h-0 flex-1 overflow-auto p-3 font-mono text-[12px] leading-[1.5]">
            {selectedPath === null ? (
              <div className="text-gray-500">Select a file to view its diff.</div>
            ) : diffError ? (
              <div className="text-gray-500">Couldn't load the diff for this file.</div>
            ) : diff === null ? (
              <div className="text-gray-500">Loading diff…</div>
            ) : diff.text.length === 0 ? (
              <div className="text-gray-500">
                {diff.truncated ? 'Diff too large to display.' : 'No textual diff.'}
              </div>
            ) : (
              <>
                {diff.text.split('\n').map((line, i) => (
                  <div key={i} className={`diff-line diff-${classifyDiffLine(line)}`}>
                    {line === '' ? ' ' : line}
                  </div>
                ))}
                {diff.truncated && (
                  <div className="mt-2 text-gray-500">… diff truncated (too large).</div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
