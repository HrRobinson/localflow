import { useCallback, useEffect, useRef, useState } from 'react'
import TerminalPane from './components/TerminalPane'
import Landing from './components/Landing'
import Settings from './components/Settings'
import Sidebar from './components/Sidebar'
import { reconcileOrder } from './lib/order'
import { pickNeighbor, swapInOrder, type PaneRect, type Direction } from './lib/pane-nav'
import { nextNeedsYou } from './lib/needs-you'
import {
  parseBinding,
  eventMatches,
  bindingEntries,
  type KeyAction,
  type ParsedBinding
} from '../../shared/keybindings'
import { clampWorkspace } from '../../shared/workspace'
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
  const [view, setView] = useState<'home' | 'terminals' | 'settings'>('home')
  // Which workspace's grid is visible. Sessions on other workspaces stay
  // mounted-invisible? No — they simply don't render; their ptys live in
  // main regardless, so nothing is lost when a pane isn't shown.
  const [workspace, setWorkspace] = useState(1)

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
    const created = await window.localflow.createSession(
      agentId,
      undefined,
      customCommand,
      workspace
    )
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
  const closeTerminal = async (id: string): Promise<void> => {
    await window.localflow.closeTerminal(id)
    await afterPaneGone(id)
  }
  const deleteSession = async (id: string): Promise<void> => {
    await window.localflow.deleteSession(id)
    await afterPaneGone(id)
  }
  const renameSession = async (id: string, name: string): Promise<void> => {
    const updated = await window.localflow.renameSession(id, name)
    if (updated) setSessions((prev) => prev.map((s) => (s.id === id ? updated : s)))
  }
  // Shared post-action cleanup: whether the pane vanished entirely
  // (deleteSession) or just went dead-but-still-listed (closeTerminal), it
  // can no longer hold keyboard focus or stay enlarged.
  const afterPaneGone = async (id: string): Promise<void> => {
    setEnlarged((cur) => (cur === id ? null : cur))
    setActiveId((cur) => {
      if (cur !== id) return cur
      const visible = order.filter(
        (oid) => oid !== id && sessions.find((s) => s.id === oid)?.workspace === workspace
      )
      const idx = order.indexOf(id)
      const after = order.slice(idx + 1).find((oid) => visible.includes(oid))
      const before = [...order.slice(0, idx)].reverse().find((oid) => visible.includes(oid))
      return after ?? before ?? null
    })
    await refresh()
  }
  const openSession = (id: string): void => {
    // Opening a session anywhere (sidebar, overview, cmd+u) must also make
    // its workspace the visible one — a focused pane in a hidden workspace
    // would be unreachable.
    const target = sessions.find((s) => s.id === id)
    if (target) setWorkspace(target.workspace)
    setView('terminals')
    setEnlarged(sessions.length > 1 ? id : null)
    setActiveId(id)
  }
  // Entering the terminals view without naming a session (sidebar nav item,
  // header "open terminals") must still yield exactly one active pane —
  // e.g. with restored sessions activeId starts out null.
  const enterTerminals = (): void => {
    setView('terminals')
    setActiveId((cur) => {
      const visible = order.filter(
        (id) => sessions.find((s) => s.id === id)?.workspace === workspace
      )
      return cur !== null && visible.includes(cur) ? cur : (visible[0] ?? null)
    })
  }
  // Switching workspaces re-scopes focus: the active/enlarged pane must be
  // one of the target workspace's panes, or null.
  const switchWorkspace = (n: number): void => {
    const target = clampWorkspace(n)
    setWorkspace(target)
    setView('terminals')
    const firstVisible =
      order.find((id) => sessions.find((s) => s.id === id)?.workspace === target) ?? null
    setActiveId((cur) =>
      cur !== null && sessions.find((s) => s.id === cur)?.workspace === target ? cur : firstVisible
    )
    setEnlarged((cur) =>
      cur !== null && sessions.find((s) => s.id === cur)?.workspace === target ? cur : null
    )
  }
  const moveToWorkspace = async (id: string, n: number): Promise<void> => {
    await window.localflow.setWorkspace(id, n)
    await refresh()
    // The pane leaves the visible grid (spec: focus stays behind): re-scope
    // focus/enlarge exactly like a closed pane.
    await afterPaneGone(id)
  }

  // The dispatcher's keydown handler is a stable closure attached once on
  // mount, so it reads current state through a ref kept in sync every
  // render rather than through the effect's own stale closure.
  const liveRef = useRef({
    view,
    activeId,
    order,
    enlarged,
    sessions,
    workspace,
    closeTerminal,
    openSession,
    switchWorkspace,
    moveToWorkspace
  })
  useEffect(() => {
    liveRef.current = {
      view,
      activeId,
      order,
      enlarged,
      sessions,
      workspace,
      closeTerminal,
      openSession,
      switchWorkspace,
      moveToWorkspace
    }
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
      // Jump-to-attention works from any view: from home/settings it enters
      // the terminals view on the first waiting pane; inside terminals it
      // cycles relative to the active pane. openSession supplies the
      // focus+enlarge semantics (enlarge only when there is more than one
      // session, same as clicking a row).
      if (action === 'focus-needs-you') {
        const live = liveRef.current
        const target = nextNeedsYou(
          live.order,
          live.sessions,
          live.view === 'terminals' ? live.activeId : null,
          live.workspace
        )
        if (target) live.openSession(target)
        return
      }
      if (action.startsWith('workspace-')) {
        liveRef.current.switchWorkspace(Number(action.slice('workspace-'.length)))
        return
      }

      // Everything else only acts within the terminals view, on the active
      // pane — a no-op elsewhere (e.g. on the home/landing view).
      const live = liveRef.current
      if (live.view !== 'terminals' || live.activeId === null) return
      const activeId = live.activeId

      if (action.startsWith('move-to-workspace-')) {
        void live.moveToWorkspace(activeId, Number(action.slice('move-to-workspace-'.length)))
        return
      }
      if (action === 'enlarge-toggle') {
        setEnlarged((cur) => (cur === activeId ? null : activeId))
        return
      }
      if (action === 'close-pane') {
        void live.closeTerminal(activeId)
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

  const showTerminals = view === 'terminals' && sessions.some((s) => s.workspace === workspace)

  return (
    <div className="flex min-h-0 flex-1">
      {sidebarVisible && (
        <Sidebar
          sessions={sessions}
          view={showTerminals ? 'terminals' : view === 'settings' ? 'settings' : 'home'}
          activeId={activeId}
          onHome={() => setView('home')}
          onTerminals={enterTerminals}
          onSettings={() => setView('settings')}
          onOpenSession={openSession}
          onDeleteSession={(id) => void deleteSession(id)}
          onRenameSession={(id, name) => void renameSession(id, name)}
        />
      )}
      {/* No content header: the sidebar IS the navigation (user decision
          2026-07-07); cmd+esc / nav items cover the old header buttons. */}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {showTerminals ? (
          <div className="grid flex-1 auto-rows-[minmax(300px,1fr)] grid-cols-[repeat(auto-fit,minmax(460px,1fr))] gap-2.5 overflow-auto px-3 pt-3 pb-3">
            {order
              .map((id) => sessions.find((s) => s.id === id))
              .filter((s): s is SessionInfo => s != null && s.workspace === workspace)
              .map((s) => (
                <TerminalPane
                  key={s.id}
                  session={s}
                  enlarged={enlarged === s.id}
                  active={activeId === s.id}
                  onToggleEnlarge={() => setEnlarged((cur) => (cur === s.id ? null : s.id))}
                  onActivate={() => setActiveId(s.id)}
                  onRestart={(fresh) => void restart(s.id, fresh)}
                  onClose={() => void closeTerminal(s.id)}
                />
              ))}
          </div>
        ) : view === 'settings' ? (
          <Settings />
        ) : (
          <Landing
            sessions={sessions}
            onCreate={(agentId, cmd) => void createSession(agentId, cmd)}
            onOpen={openSession}
            onResume={(id, fresh) => void restart(id, fresh)}
            onDelete={(id) => void deleteSession(id)}
            onRename={(id, name) => void renameSession(id, name)}
            onOpenSettings={() => setView('settings')}
          />
        )}
      </main>
    </div>
  )
}
