import { useCallback, useEffect, useRef, useState } from 'react'
import TerminalPane from './components/TerminalPane'
import Landing from './components/Landing'
import Sidebar from './components/Sidebar'
import { reconcileOrder } from './lib/order'
import { pickNeighbor, swapInOrder, type PaneRect, type Direction } from './lib/pane-nav'
import {
  parseBinding,
  eventMatches,
  bindingEntries,
  type KeyAction,
  type ParsedBinding
} from '../../shared/keybindings'
import type { AgentId, SessionInfo } from '../../shared/types'

// Which pane-nav direction each focus-*/swap-* action moves in.
const ACTION_DIRECTION: Partial<Record<KeyAction, Direction>> = {
  'focus-left': 'left',
  'focus-down': 'down',
  'focus-up': 'up',
  'focus-right': 'right',
  'swap-left': 'left',
  'swap-down': 'down',
  'swap-up': 'up',
  'swap-right': 'right'
}

export default function App(): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [enlarged, setEnlarged] = useState<string | null>(null)
  // cmd+b hides the sidebar for a fullscreen-style focus mode.
  const [sidebarVisible, setSidebarVisible] = useState(true)
  // Which pane has keyboard focus, and the display order panes render in.
  // `order` is reconciled from `sessions` on every refresh: new ids are
  // appended, ids no longer present are dropped, everything else is stable.
  const [activeId, setActiveId] = useState<string | null>(null)
  const [order, setOrder] = useState<string[]>([])
  // The app opens on the home overview; terminals are entered explicitly.
  const [view, setView] = useState<'home' | 'terminals'>('home')

  const refresh = useCallback(async () => {
    const list = await window.localflow.listSessions()
    setSessions(list)
    setOrder((cur) =>
      reconcileOrder(
        cur,
        list.map((s) => s.id)
      )
    )
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount
    void refresh()
    const offStatus = window.localflow.onStatus((id, status) => {
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, status } : s)))
    })
    // Session state arrives via two paths: pushed onStatus events (fast path
    // for status transitions) and this 1s poll (catches everything else,
    // e.g. sessions created/removed elsewhere). Both write into the same
    // `sessions` state, so they must stay reconcilable — poll results should
    // never regress a status a pushed event has already advanced past.
    const iv = setInterval(() => void refresh(), 1000)
    return () => {
      offStatus()
      clearInterval(iv)
    }
  }, [refresh])

  const createSession = async (agentId: AgentId, customCommand?: string): Promise<void> => {
    const created = await window.localflow.createSession(agentId, undefined, customCommand)
    if (created) {
      setView('terminals')
      // A pane enlarged before we left the terminals view would otherwise
      // stay fixed-position on top of the newly created (active) pane.
      setEnlarged(null)
      setActiveId(created.id)
      await refresh()
    }
  }
  const restart = async (id: string, fresh: boolean): Promise<void> => {
    await window.localflow.restartSession(id, fresh)
    await refresh()
  }
  const close = async (id: string): Promise<void> => {
    await window.localflow.killSession(id)
    setEnlarged((cur) => (cur === id ? null : cur))
    setActiveId((cur) => {
      if (cur !== id) return cur
      const idx = order.indexOf(id)
      if (idx === -1) return null
      return order[idx + 1] ?? order[idx - 1] ?? null
    })
    await refresh()
  }
  const openSession = (id: string): void => {
    setView('terminals')
    setEnlarged(sessions.length > 1 ? id : null)
    setActiveId(id)
  }
  // Entering the terminals view without naming a session (sidebar nav item,
  // header "open terminals") must still yield exactly one active pane —
  // e.g. with restored sessions activeId starts out null.
  const enterTerminals = (): void => {
    setView('terminals')
    setActiveId((cur) => (cur !== null && order.includes(cur) ? cur : (order[0] ?? null)))
  }

  // The dispatcher's keydown handler is a stable closure attached once on
  // mount, so it reads current state through a ref kept in sync every
  // render rather than through the effect's own stale closure.
  const liveRef = useRef({ view, activeId, order, enlarged, close })
  useEffect(() => {
    liveRef.current = { view, activeId, order, enlarged, close }
  })

  useEffect(() => {
    const bindings: [KeyAction, ParsedBinding][] = []
    void (async () => {
      const raw = await window.localflow.getKeybindings()
      for (const [action, binding] of bindingEntries(raw)) {
        const parsed = parseBinding(binding)
        if (parsed) bindings.push([action, parsed])
      }
    })()

    // Capture phase: this dispatcher runs before terminal xterm instances
    // see the event, so it can claim bound combos (cmd+w, cmd+enter, ...)
    // that would otherwise be swallowed or misinterpreted by the terminal.
    // Unmatched events are left completely untouched, falling through to
    // whichever terminal has focus.
    const onKey = (e: KeyboardEvent): void => {
      const match = bindings.find(([, binding]) => eventMatches(binding, e))
      if (!match) return
      const [action] = match
      e.preventDefault()
      e.stopPropagation()

      // go-up is available everywhere: shrink an enlarged pane, else leave
      // the terminals view entirely. Same shrink-else-home semantics as
      // before this became a bound action.
      if (action === 'go-up') {
        setEnlarged((cur) => {
          if (cur !== null) return null
          setView('home')
          return cur
        })
        return
      }
      if (action === 'new-session') {
        setView('home')
        return
      }
      if (action === 'toggle-sidebar') {
        setSidebarVisible((cur) => !cur)
        return
      }

      // Everything else only acts within the terminals view, on the active
      // pane — a no-op elsewhere (e.g. on the home/landing view).
      const live = liveRef.current
      if (live.view !== 'terminals' || live.activeId === null) return
      const activeId = live.activeId

      if (action === 'enlarge-toggle') {
        setEnlarged((cur) => (cur === activeId ? null : activeId))
        return
      }
      if (action === 'close-pane') {
        void live.close(activeId)
        return
      }

      // Directional focus/swap moves are a no-op while a pane is enlarged —
      // there is nothing else visible to move to.
      if (live.enlarged !== null) return
      const dir = ACTION_DIRECTION[action]
      if (!dir) return

      const rects: PaneRect[] = Array.from(document.querySelectorAll<HTMLElement>('.pane')).flatMap(
        (el) => {
          const id = el.dataset.paneId
          if (!id) return []
          const r = el.getBoundingClientRect()
          return [{ id, x: r.x, y: r.y, w: r.width, h: r.height }]
        }
      )
      const neighbor = pickNeighbor(rects, activeId, dir)
      if (!neighbor) return

      if (action.startsWith('focus-')) {
        setActiveId(neighbor)
      } else {
        setOrder((cur) => swapInOrder(cur, activeId, neighbor))
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const showTerminals = view === 'terminals' && sessions.length > 0

  return (
    <div className="flex min-h-0 flex-1">
      {sidebarVisible && (
        <Sidebar
          sessions={sessions}
          view={showTerminals ? 'terminals' : 'home'}
          activeId={activeId}
          onHome={() => setView('home')}
          onTerminals={enterTerminals}
          onOpenSession={openSession}
        />
      )}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-white/[0.06] px-6 py-3">
          <h2 className="m-0 text-[15px] font-semibold tracking-[-0.01em]">
            {showTerminals ? 'Terminals' : 'Overview'}
          </h2>
          {showTerminals ? (
            <button
              className="cursor-pointer rounded-md border border-white/10 bg-white/[0.06] px-3 py-[5px] text-xs text-gray-300 hover:bg-white/[0.12] hover:text-white"
              onClick={() => setView('home')}
              onMouseDown={(e) => e.preventDefault()}
              title="cmd+esc"
            >
              home
            </button>
          ) : (
            sessions.length > 0 && (
              <button
                className="cursor-pointer rounded-md border border-white/10 bg-white/[0.06] px-3 py-[5px] text-xs text-gray-300 hover:bg-white/[0.12] hover:text-white"
                onClick={enterTerminals}
                onMouseDown={(e) => e.preventDefault()}
              >
                open terminals
              </button>
            )
          )}
        </header>
        {showTerminals ? (
          <div className="grid flex-1 auto-rows-[minmax(300px,1fr)] grid-cols-[repeat(auto-fit,minmax(460px,1fr))] gap-2.5 overflow-auto px-3 pb-3">
            {order
              .map((id) => sessions.find((s) => s.id === id))
              .filter((s): s is SessionInfo => s != null)
              .map((s) => (
                <TerminalPane
                  key={s.id}
                  session={s}
                  enlarged={enlarged === s.id}
                  active={activeId === s.id}
                  onToggleEnlarge={() => setEnlarged((cur) => (cur === s.id ? null : s.id))}
                  onActivate={() => setActiveId(s.id)}
                  onRestart={(fresh) => void restart(s.id, fresh)}
                  onClose={() => void close(s.id)}
                />
              ))}
          </div>
        ) : (
          <Landing
            sessions={sessions}
            onCreate={(agentId, cmd) => void createSession(agentId, cmd)}
            onOpen={openSession}
            onResume={(id, fresh) => void restart(id, fresh)}
            onRemove={(id) => void close(id)}
          />
        )}
      </main>
    </div>
  )
}
