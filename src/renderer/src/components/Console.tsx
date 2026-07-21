import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ConsoleEvent, ConsoleSource } from '../../../shared/console'
import { DEFAULT_CONSOLE_PREFS } from '../../../shared/console'
import { rowActions } from '../../../shared/console-actions'
import {
  visibleEvents,
  deriveConsoleScope,
  appendConsoleEvents,
  emptyConsoleRings,
  ringsFromSnapshot,
  mergeConsoleRings,
  type ConsoleFilter,
  type ConsoleScope,
  type ConsoleFocus,
  type ConsoleRings
} from '../../../shared/console-filter'

const SOURCES: ConsoleSource[] = ['status', 'operator', 'capture', 'guard', 'network']

const MIN_HEIGHT = 120
const MAX_HEIGHT = 600
const PERSIST_DEBOUNCE_MS = 300

const ACTION_LABEL: Record<'rerun-watchpoint' | 'open-source', string> = {
  'rerun-watchpoint': 'rerun watchpoint',
  'open-source': 'open source'
}

interface ConsoleProps {
  open: boolean
  onClose: () => void
  focus: ConsoleFocus
  /** Reflect-and-replay row actions: jump to the row's source (session/cockpit). */
  onOpenSource: (event: ConsoleEvent) => void
  /** Re-arm a capture row's watchpoint (show-not-author — no request composition). */
  onRerunWatchpoint: (event: ConsoleEvent) => void
}

export function Console({
  open,
  onClose,
  focus,
  onOpenSource,
  onRerunWatchpoint
}: ConsoleProps): React.JSX.Element | null {
  const [eventRings, setEventRings] = useState<ConsoleRings>(emptyConsoleRings())
  const [sources, setSources] = useState<Set<ConsoleSource>>(new Set())
  const [muted, setMuted] = useState<Set<ConsoleSource>>(new Set())
  const [scopeMode, setScopeMode] = useState<'auto' | ConsoleScope>('auto')
  const [text, setText] = useState('')
  const [height, setHeight] = useState(DEFAULT_CONSOLE_PREFS.height)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [previews, setPreviews] = useState<Map<string, string>>(new Map())
  const listRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  // Guards the persist effect from clobbering disk with defaults before the
  // one-time initial load below has resolved.
  const hydrated = useRef(false)

  // Seed height/sources/text from disk once, regardless of open state, so
  // the drawer already reflects the last session the first time it opens.
  useEffect(() => {
    let alive = true
    void window.saiife.getConsolePrefs().then((prefs) => {
      if (!alive) return
      setHeight(prefs.height)
      setSources(new Set(prefs.sources))
      setMuted(new Set(prefs.muted))
      setText(prefs.text)
      setScopeMode(prefs.scope)
      hydrated.current = true
    })
    return () => {
      alive = false
    }
  }, [])

  // Debounce-persist height/open/sources/text/scope so dragging doesn't hammer disk.
  useEffect(() => {
    if (!hydrated.current) return
    const timer = setTimeout(() => {
      window.saiife.setConsolePrefs({
        height,
        open,
        sources: Array.from(sources),
        text,
        scope: scopeMode,
        muted: Array.from(muted)
      })
    }, PERSIST_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [height, open, sources, text, scopeMode, muted])

  // Snapshot on open + live subscription while mounted.
  useEffect(() => {
    if (!open) return
    let alive = true
    void window.saiife.listConsole().then((snap) => {
      if (alive) setEventRings(ringsFromSnapshot(snap))
    })
    const off = window.saiife.onConsoleEvent((e) =>
      setEventRings((prev) => appendConsoleEvents(prev, Array.isArray(e) ? e : [e]))
    )
    return () => {
      alive = false
      off()
    }
  }, [open])

  const events = useMemo(() => mergeConsoleRings(eventRings), [eventRings])

  // Lazy thumbnail fetch: only when a capture row with a screenshotPath is
  // expanded, and only once per path (cached in `previews`).
  useEffect(() => {
    if (!expanded) return
    const row = events.find((e) => e.id === expanded)
    if (!row || row.detail.source !== 'capture') return
    const path = row.detail.screenshotPath
    if (!path || previews.has(path)) return
    let alive = true
    void window.saiife.readScreenshot(path).then((uri) => {
      if (alive && uri) setPreviews((prev) => new Map(prev).set(path, uri))
    })
    return () => {
      alive = false
    }
  }, [expanded, events, previews])

  const scope: ConsoleScope = scopeMode === 'auto' ? deriveConsoleScope(focus) : scopeMode
  const filter: ConsoleFilter = { sources, muted, scope, text }
  const rows = visibleEvents(events, filter)

  // Auto-scroll to newest unless the user scrolled up.
  useLayoutEffect(() => {
    const el = listRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [rows.length, open])

  function onScroll(): void {
    const el = listRef.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }

  function toggleSource(s: ConsoleSource): void {
    setSources((prev) => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      return next
    })
  }

  function toggleMute(s: ConsoleSource): void {
    setMuted((prev) => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      return next
    })
  }

  // Top-edge drag-resize: dragging up (clientY decreasing) grows the drawer.
  function onResizePointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    e.preventDefault()
    const startY = e.clientY
    const startHeight = height
    function onMove(ev: PointerEvent): void {
      const next = startHeight + (startY - ev.clientY)
      setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, next)))
    }
    function onUp(): void {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  if (!open) return null

  return (
    <div
      data-console
      className="fixed right-0 bottom-0 left-0 z-40 flex flex-col border-t border-white/10 bg-black/80 text-white/80 backdrop-blur"
      style={{ height }}
    >
      <div
        data-console-resize
        onPointerDown={onResizePointerDown}
        className="h-1 shrink-0 cursor-row-resize hover:bg-white/20"
      />
      <div className="flex items-center gap-2 px-3 py-1.5 text-[12px]">
        <div className="flex gap-1">
          {SOURCES.map((s) => (
            <span
              key={s}
              data-console-chip={s}
              data-muted={muted.has(s)}
              className={`inline-flex items-center rounded border ${
                muted.has(s)
                  ? 'border-white/10 text-white/25'
                  : sources.size === 0 || sources.has(s)
                    ? 'border-white/40 text-white'
                    : 'border-white/10 text-white/40'
              }`}
            >
              <button
                data-console-source={s}
                data-active={sources.size === 0 || sources.has(s)}
                className={`cursor-pointer bg-transparent px-1.5 py-0.5 ${muted.has(s) ? 'line-through' : ''}`}
                onClick={() => toggleSource(s)}
                onMouseDown={(ev) => ev.preventDefault()}
              >
                {s}
              </button>
              <button
                data-console-mute={s}
                aria-label={`${muted.has(s) ? 'unmute' : 'mute'} ${s}`}
                title={muted.has(s) ? `unmute ${s}` : `mute ${s}`}
                className="cursor-pointer border-0 border-l border-white/10 bg-transparent px-1 py-0.5 text-white/40 hover:text-white"
                onClick={() => toggleMute(s)}
                onMouseDown={(ev) => ev.preventDefault()}
              >
                {muted.has(s) ? '🔇' : '×'}
              </button>
            </span>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <button
            data-console-scope="everywhere"
            className="cursor-pointer rounded border border-white/20 px-1.5 py-0.5"
            onClick={() => setScopeMode({ kind: 'everywhere' })}
            onMouseDown={(e) => e.preventDefault()}
          >
            everywhere
          </button>
          <button
            data-console-scope="here"
            className="cursor-pointer rounded border border-white/20 px-1.5 py-0.5"
            onClick={() => setScopeMode(deriveConsoleScope(focus))}
            onMouseDown={(e) => e.preventDefault()}
          >
            pin here
          </button>
          {scopeMode !== 'auto' && (
            <button
              data-console-follow
              className="cursor-pointer rounded border border-white/20 px-1.5 py-0.5"
              onClick={() => setScopeMode('auto')}
              onMouseDown={(e) => e.preventDefault()}
            >
              follow
            </button>
          )}
        </div>
        <input
          data-console-text
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="filter…"
          className="min-w-0 flex-1 rounded border border-white/10 bg-transparent px-2 py-0.5 outline-none"
        />
        <button
          data-console-close
          className="cursor-pointer border-0 bg-transparent text-white/50 hover:text-white"
          onClick={onClose}
          onMouseDown={(e) => e.preventDefault()}
        >
          close
        </button>
      </div>
      <div
        ref={listRef}
        data-console-list
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto px-3 pb-2 font-mono text-[12px]"
      >
        {rows.map((e) => (
          <div key={e.id} data-console-row data-source={e.source}>
            <button
              className="flex w-full cursor-pointer items-baseline gap-2 border-0 bg-transparent py-0.5 text-left text-white/80 hover:text-white"
              onClick={() => setExpanded((cur) => (cur === e.id ? null : e.id))}
              onMouseDown={(ev) => ev.preventDefault()}
            >
              <span className="text-white/40">{new Date(e.ts).toLocaleTimeString()}</span>
              <span className="text-white/50">env{e.environment}</span>
              <span className="flex-1">{e.label}</span>
            </button>
            {expanded === e.id && (
              <div className="py-1 pl-16">
                {e.detail.source === 'capture' &&
                  e.detail.screenshotPath &&
                  previews.has(e.detail.screenshotPath) && (
                    <img
                      data-console-thumb
                      src={previews.get(e.detail.screenshotPath)}
                      alt="screenshot"
                      className="mb-1 max-h-40 max-w-full rounded border border-white/10"
                    />
                  )}
                <pre data-console-detail className="overflow-x-auto text-white/60">
                  {JSON.stringify(e.detail, null, 2)}
                </pre>
                <div className="flex gap-2 pt-1">
                  {rowActions(e).map((action) => (
                    <button
                      key={action}
                      data-console-action={action}
                      className="cursor-pointer rounded border border-white/20 px-1.5 py-0.5 text-white/70 hover:text-white"
                      onClick={() =>
                        action === 'open-source' ? onOpenSource(e) : onRerunWatchpoint(e)
                      }
                      onMouseDown={(ev) => ev.preventDefault()}
                    >
                      {ACTION_LABEL[action]}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
