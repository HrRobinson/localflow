import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ConsoleEvent, ConsoleSource } from '../../../shared/console'
import {
  visibleEvents,
  deriveConsoleScope,
  type ConsoleFilter,
  type ConsoleScope,
  type ConsoleFocus
} from '../../../shared/console-filter'

const SOURCES: ConsoleSource[] = ['status', 'operator', 'capture']

interface ConsoleProps {
  open: boolean
  onClose: () => void
  focus: ConsoleFocus
}

export function Console({ open, onClose, focus }: ConsoleProps): React.JSX.Element | null {
  const [events, setEvents] = useState<ConsoleEvent[]>([])
  const [sources, setSources] = useState<Set<ConsoleSource>>(new Set())
  const [scopeMode, setScopeMode] = useState<'auto' | ConsoleScope>('auto')
  const [text, setText] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  // Snapshot on open + live subscription while mounted.
  useEffect(() => {
    if (!open) return
    let alive = true
    void window.localflow.listConsole().then((snap) => {
      if (alive) setEvents(snap)
    })
    const off = window.localflow.onConsoleEvent((e) => setEvents((prev) => [...prev, e]))
    return () => {
      alive = false
      off()
    }
  }, [open])

  const scope: ConsoleScope = scopeMode === 'auto' ? deriveConsoleScope(focus) : scopeMode
  const filter: ConsoleFilter = { sources, scope, text }
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

  if (!open) return null

  return (
    <div
      data-console
      className="fixed right-0 bottom-0 left-0 z-40 flex flex-col border-t border-white/10 bg-black/80 text-white/80 backdrop-blur"
      style={{ height: 240 }}
    >
      <div className="flex items-center gap-2 px-3 py-1.5 text-[12px]">
        <div className="flex gap-1">
          {SOURCES.map((s) => (
            <button
              key={s}
              data-console-source={s}
              data-active={sources.size === 0 || sources.has(s)}
              className={`cursor-pointer rounded border px-1.5 py-0.5 ${
                sources.size === 0 || sources.has(s)
                  ? 'border-white/40 text-white'
                  : 'border-white/10 text-white/40'
              }`}
              onClick={() => toggleSource(s)}
              onMouseDown={(e) => e.preventDefault()}
            >
              {s}
            </button>
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
              <pre data-console-detail className="overflow-x-auto py-1 pl-16 text-white/60">
                {JSON.stringify(e.detail, null, 2)}
              </pre>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
