import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { SessionInfo } from '../../../shared/types'
import type { XtermTheme } from '../../../shared/theme'
import type { Capabilities } from '../../../shared/git'
import ApproveButton from './ApproveButton'

interface Props {
  session: SessionInfo
  enlarged: boolean
  active: boolean
  onToggleEnlarge: () => void
  onActivate: () => void
  /** Relaunch the agent; `fresh` starts a new conversation instead of resuming. */
  onRestart: (fresh: boolean) => void
  onClose: () => void
  /** Launch the configured editor on this session's cwd (external app). */
  onOpenEditor: () => void
  /** Editor availability + configured command; null while capabilities load. */
  editor: Capabilities['editor'] | null
  /** Live terminal theme (xterm ITheme + font); applied on change. */
  terminalTheme: { theme: XtermTheme; fontFamily: string; fontSize: number }
}

export default function TerminalPane({
  session,
  enlarged,
  active,
  onToggleEnlarge,
  onActivate,
  onRestart,
  onClose,
  onOpenEditor,
  editor,
  terminalTheme
}: Props): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const alive = session.status !== 'exited'

  useEffect(() => {
    if (!alive || !hostRef.current) return
    const term = new Terminal({
      fontSize: terminalTheme.fontSize,
      fontFamily: terminalTheme.fontFamily,
      theme: terminalTheme.theme
    })
    termRef.current = term
    const fit = new FitAddon()
    fitRef.current = fit
    term.loadAddon(fit)
    term.open(hostRef.current)
    fit.fit()
    window.saiife.resize(session.id, term.cols, term.rows)
    // Switching views unmounts the grid (App.tsx), so returning creates a
    // FRESH xterm whose onData only sees NEW pty bytes — the pane would be
    // blank until a keystroke provokes a redraw. Replay the pane's current
    // rendered screen (from the headless emulator in main) so it paints its
    // last frame immediately. Guarded against a mount that already tore down.
    let cancelled = false
    // If live pty bytes arrive before the snapshot round-trip resolves, the
    // stale replay would overwrite them and garble the pane — skip the
    // replay write once real data has started flowing.
    let liveData = false
    void window.saiife.snapshotSession(session.id).then((lines) => {
      if (cancelled || termRef.current !== term || liveData) return
      if (lines.length > 0) term.write(lines.join('\r\n'))
      term.refresh(0, term.rows - 1)
    })
    const offData = window.saiife.onData((id, data) => {
      if (id === session.id) {
        liveData = true
        term.write(data)
      }
    })
    const onInput = term.onData((d) => window.saiife.write(session.id, d))
    const ro = new ResizeObserver(() => {
      fit.fit()
      window.saiife.resize(session.id, term.cols, term.rows)
    })
    ro.observe(hostRef.current)
    return () => {
      cancelled = true
      offData()
      onInput.dispose()
      ro.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [session.id, alive])

  // Live-apply theme/font changes without rebuilding the terminal.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = terminalTheme.theme
    term.options.fontFamily = terminalTheme.fontFamily
    term.options.fontSize = terminalTheme.fontSize
    fitRef.current?.fit()
    window.saiife.resize(session.id, term.cols, term.rows)
  }, [terminalTheme, session.id])

  // Keep DOM focus on the active pane's terminal — after activation changes,
  // and after the environment view (re)mounts panes.
  useEffect(() => {
    if (active && alive) termRef.current?.focus()
  }, [active, alive])

  const name = session.name
  const agentLabel =
    session.agentId === 'custom' ? session.command.split('/').pop() : session.agentId
  const paneHeaderBtn =
    'cursor-pointer border-0 bg-transparent text-xs text-gray-400 hover:text-white'
  return (
    <div
      className={
        'pane border-exited bg-surface-raised flex min-h-0 flex-col overflow-hidden rounded-lg border-2' +
        (enlarged ? ' enlarged' : '') +
        (active ? ' active' : '')
      }
      data-pane-id={session.id}
      data-status={session.status}
      onMouseDown={() => {
        onActivate()
        // setActiveId bails out when this pane is already active, so the
        // focus effect below never re-runs and Chromium is free to blur the
        // terminal to <body> on a header/gutter click. Force it back.
        if (active) termRef.current?.focus()
      }}
    >
      <div
        className="pane-header flex cursor-pointer items-center gap-2 bg-white/[0.04] px-2.5 py-1 text-xs select-none"
        onDoubleClick={onToggleEnlarge}
        onMouseDown={(e) => {
          // Keep the terminal from losing DOM focus when clicking the header
          // chrome itself — let the event keep bubbling to the pane root so
          // onActivate above still runs (activation/re-focus for inactive
          // panes must still work).
          e.preventDefault()
        }}
      >
        <span className="dot bg-exited h-2.5 w-2.5 rounded-full" />
        <span
          className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
          title={session.cwd}
        >
          {name}
        </span>
        <span className="rounded bg-white/[0.06] px-1.5 py-px font-mono text-[10px] text-gray-400">
          {agentLabel}
        </span>
        {session.guardVerification === 'unverified' && (
          <span
            className="rounded border border-amber-400/40 bg-amber-400/10 px-1.5 py-px font-mono text-[10px] text-amber-300"
            title="saiifeguard is configured for this Codex pane, but no enforcement has been observed yet — it is armed but unproven. The badge clears the first time a command actually reaches the guard this session. It does not mean the guard is broken."
          >
            guard: not yet observed
          </span>
        )}
        {session.status === 'needs-you' && (
          <ApproveButton
            sessionId={session.id}
            buttonClassName={`${paneHeaderBtn} !text-yellow-300 hover:!text-yellow-200`}
            stopMouseDown
          />
        )}
        <button
          className={`open-editor ${paneHeaderBtn} disabled:cursor-default disabled:opacity-40 disabled:hover:text-gray-400`}
          disabled={editor !== null && !editor.available}
          title={
            editor && !editor.available
              ? editor.hint
              : `Open this folder in ${editor?.command ?? 'your editor'}`
          }
          onClick={onOpenEditor}
          onDoubleClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => {
            // Same focus discipline as the close button: no focus steal, no
            // bubbling to the pane root — opening an external editor must
            // not activate a non-active pane.
            e.preventDefault()
            e.stopPropagation()
          }}
        >
          editor
        </button>
        <button
          className={paneHeaderBtn}
          onClick={() => {
            // Enlarging must activate the pane, explicitly — an enlarged
            // non-active pane would cover the grid while the previously
            // active terminal keeps keyboard focus underneath it.
            onActivate()
            onToggleEnlarge()
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
        >
          {enlarged ? 'shrink' : 'enlarge'}
        </button>
        <button
          className={paneHeaderBtn}
          onClick={onClose}
          onDoubleClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => {
            // preventDefault keeps focus off the button; stopPropagation keeps
            // the mousedown from bubbling to the pane root's onActivate —
            // closing a non-active pane must not first make it active.
            e.preventDefault()
            e.stopPropagation()
          }}
        >
          close
        </button>
      </div>
      {alive ? (
        <div className="term-host min-h-0 flex-1 p-1" ref={hostRef} />
      ) : session.resumeFailed ? (
        // A resume attempt that instant-exited likely means the saved
        // conversation is gone — lead with "Start fresh" (primary) and
        // demote "Resume conversation" instead of presenting both as equals.
        <div className="restart-overlay flex flex-1 flex-col items-center justify-center gap-3">
          {session.message && (
            <p className="m-0 max-w-[80%] px-4 text-center text-[13px] text-gray-400">
              {session.message}
            </p>
          )}
          <p className="m-0 max-w-[80%] px-4 text-center text-[13px] text-gray-400">
            Resume failed instantly — this conversation may be gone.
          </p>
          <div className="flex gap-2.5">
            <button
              className="cursor-pointer rounded-md border-0 bg-gray-700 px-4 py-2 text-white"
              onClick={() => onRestart(true)}
              onMouseDown={(e) => e.preventDefault()}
            >
              Start fresh
            </button>
            <button
              className="cursor-pointer rounded-md border border-white/20 bg-transparent px-4 py-2 text-gray-300"
              onClick={() => onRestart(false)}
              onMouseDown={(e) => e.preventDefault()}
            >
              Resume conversation
            </button>
          </div>
        </div>
      ) : (
        <div className="restart-overlay flex flex-1 flex-col items-center justify-center gap-3">
          {session.message && (
            <p className="m-0 max-w-[80%] px-4 text-center text-[13px] text-gray-400">
              {session.message}
            </p>
          )}
          <div className="flex gap-2.5">
            <button
              className="cursor-pointer rounded-md border-0 bg-gray-700 px-4 py-2 text-white"
              onClick={() => onRestart(false)}
              onMouseDown={(e) => e.preventDefault()}
            >
              Resume conversation
            </button>
            <button
              className="cursor-pointer rounded-md border-0 bg-gray-700 px-4 py-2 text-white"
              onClick={() => onRestart(true)}
              onMouseDown={(e) => e.preventDefault()}
            >
              Start fresh
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
