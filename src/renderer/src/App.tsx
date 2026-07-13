import { useCallback, useEffect, useRef, useState } from 'react'
import TerminalPane from './components/TerminalPane'
import BrowserPane from './components/BrowserPane'
import GroupBox from './components/GroupBox'
import Landing from './components/Landing'
import Settings from './components/Settings'
import Activity from './components/Activity'
import Sidebar from './components/Sidebar'
import Changes from './components/Changes'
import Cockpit from './components/Cockpit'
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
import { clampEnvironment, worstStatus } from '../../shared/environment'
import { groupedOrder } from '../../shared/group-order'
import { nextFocusAfterClose } from '../../shared/close-focus'
import type { AgentId, SessionGroup, SessionInfo } from '../../shared/types'
import {
  DEFAULT_THEME,
  themeToCssVars,
  themeToXterm,
  type Theme,
  type XtermTheme
} from '../../shared/theme'

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
  // Groups ("sessions" in UI copy) a pane can belong to; polled alongside
  // sessions in refresh() so the grid's grouping stays in sync.
  const [groups, setGroups] = useState<SessionGroup[]>([])
  const [enlarged, setEnlarged] = useState<string | null>(null)
  // cmd+b hides the sidebar for a fullscreen-style focus mode.
  const [sidebarVisible, setSidebarVisible] = useState(true)
  // Which pane has keyboard focus, and the display order panes render in.
  // `order` is reconciled from `sessions` on every refresh: new ids are
  // appended, ids no longer present are dropped, everything else is stable.
  const [activeId, setActiveId] = useState<string | null>(null)
  const [order, setOrder] = useState<string[]>([])
  // The app opens on the home overview; the environment view is entered explicitly.
  const [view, setView] = useState<
    'home' | 'environment' | 'settings' | 'changes' | 'activity' | 'cockpit'
  >('home')
  // Which environment's grid is visible. Sessions on other environments stay
  // mounted-invisible? No — they simply don't render; their ptys live in
  // main regardless, so nothing is lost when a pane isn't shown.
  const [environment, setEnvironment] = useState(1)
  // Which session the Changes view is reviewing (scoped, one at a time).
  const [changesSessionId, setChangesSessionId] = useState<string | null>(null)
  // Terminal theme handed to every TerminalPane; app tokens go straight onto
  // :root. Both live-update on the theme:changed push.
  const [terminalTheme, setTerminalTheme] = useState<{
    theme: XtermTheme
    fontFamily: string
    fontSize: number
  }>(() => themeToXterm(DEFAULT_THEME))
  const [themeNotice, setThemeNotice] = useState<string | null>(null)
  // Which environments currently have an operator, for the sidebar indicator.
  const [grantedEnvs, setGrantedEnvs] = useState<Set<number>>(new Set())
  useEffect(() => {
    let cancelled = false
    const tick = async (): Promise<void> => {
      const envs = [...new Set(sessions.map((s) => s.environment))]
      const flags = await Promise.all(envs.map((e) => window.localflow.operatorStatus(e)))
      if (cancelled) return
      setGrantedEnvs(new Set(flags.filter((f) => f.granted).map((f) => f.environment)))
    }
    void tick()
    const iv = setInterval(() => void tick(), 3000)
    return () => {
      cancelled = true
      clearInterval(iv)
    }
  }, [sessions])

  // Returns the freshly fetched session list so callers that need
  // post-refresh truth (e.g. moveToEnvironment) don't have to read it back
  // out of the `sessions` state closure, which won't reflect this refresh
  // until the next render.
  const refresh = useCallback(async (): Promise<SessionInfo[]> => {
    const [list, groupList] = await Promise.all([
      window.localflow.listSessions(),
      window.localflow.listGroups()
    ])
    setSessions(list)
    setGroups(groupList)
    setOrder((cur) =>
      reconcileOrder(
        cur,
        list.map((s) => s.id)
      )
    )
    return list
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
      environment
    )
    if (created) {
      setView('environment')
      // A pane enlarged before we left the environment view would otherwise
      // stay fixed-position on top of the newly created (active) pane.
      setEnlarged(null)
      setActiveId(created.id)
      await refresh()
    }
  }
  const createBrowser = async (url: string): Promise<void> => {
    const created = await window.localflow.createBrowserSession(url, environment)
    if (created) {
      setView('environment')
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
      const scoped = sessions.filter((s) => s.environment === environment)
      return nextFocusAfterClose(id, order, scoped)
    })
    await refresh()
  }
  const openSession = (id: string): void => {
    // Opening a session anywhere (sidebar, overview, cmd+u) must also make
    // its environment the visible one — a focused pane in a hidden environment
    // would be unreachable.
    const target = sessions.find((s) => s.id === id)
    if (target) setEnvironment(target.environment)
    setView('environment')
    setEnlarged(sessions.length > 1 ? id : null)
    setActiveId(id)
  }
  // Entering the environment view without naming a session (sidebar nav item,
  // header "open environment") must still yield exactly one active pane —
  // e.g. with restored sessions activeId starts out null.
  const enterEnvironment = (): void => {
    setView('environment')
    setActiveId((cur) => {
      const visible = order.filter(
        (id) => sessions.find((s) => s.id === id)?.environment === environment
      )
      return cur !== null && visible.includes(cur) ? cur : (visible[0] ?? null)
    })
  }
  // Enter the read-only Changes view scoped to one session (overview row action).
  const openChanges = (id: string): void => {
    setChangesSessionId(id)
    setEnlarged(null)
    setView('changes')
  }
  // Nav-item entry (no session named): keep the current target if it still
  // exists, else fall back to the active pane or the first terminal session.
  const enterChanges = (): void => {
    setChangesSessionId((cur) => {
      if (cur !== null && sessions.some((s) => s.id === cur && s.kind !== 'browser')) return cur
      const activeIsTerminal =
        activeId !== null && sessions.find((s) => s.id === activeId)?.kind !== 'browser'
      return (
        (activeIsTerminal ? activeId : null) ??
        sessions.find((s) => s.kind !== 'browser')?.id ??
        null
      )
    })
    setEnlarged(null)
    setView('changes')
  }
  // "Open lazygit here": main spawns a custom lazygit session in the reviewed
  // session's own cwd + environment; jump to it in the environment grid.
  const openLazygit = async (sessionId: string): Promise<void> => {
    const created = await window.localflow.openLazygit(sessionId)
    if (created) {
      setEnvironment(created.environment)
      setView('environment')
      setEnlarged(null)
      setActiveId(created.id)
      await refresh()
    }
  }
  const enterActivity = (): void => setView('activity')
  const enterCockpit = (): void => setView('cockpit')
  // Switching environments re-scopes focus: the active/enlarged pane must be
  // one of the target environment's panes, or null.
  const switchEnvironment = (n: number): void => {
    const target = clampEnvironment(n)
    setEnvironment(target)
    setView('environment')
    const firstVisible =
      order.find((id) => sessions.find((s) => s.id === id)?.environment === target) ?? null
    setActiveId((cur) =>
      cur !== null && sessions.find((s) => s.id === cur)?.environment === target
        ? cur
        : firstVisible
    )
    setEnlarged((cur) =>
      cur !== null && sessions.find((s) => s.id === cur)?.environment === target ? cur : null
    )
  }
  const moveToEnvironment = async (id: string, n: number): Promise<void> => {
    await window.localflow.setEnvironment(id, n)
    // The pane leaves the visible grid (spec: focus stays behind), but unlike
    // close/delete it's still a live session — just on another environment.
    // For a grouped pane, the whole group moved with it (session-manager
    // setEnvironment drags every member along synchronously). afterPaneGone
    // can't be reused as-is here: it computes next-focus from the pre-refresh
    // `sessions` closure, which for delete/close still holds the pane being
    // removed (needed to recover its groupId) but here would still show the
    // moved siblings as belonging to this environment (stale), so
    // nextFocusAfterClose's sibling-preference would land focus on a pane
    // that has actually left the grid. So: refresh FIRST, and compute next
    // focus from the list refresh() just fetched (not the `sessions` state,
    // which won't reflect this refresh until the next render) — by the time
    // we scope it to this environment, every moved sibling is correctly gone.
    setEnlarged((cur) => (cur === id ? null : cur))
    const list = await refresh()
    setActiveId((cur) => {
      if (cur !== id) return cur
      const scoped = list.filter((s) => s.environment === environment)
      return nextFocusAfterClose(id, order, scoped)
    })
  }
  // The Overview "waiting Nm" fragment jumps to attention exactly like cmd+u:
  // start from the top of the needs-you ring (activeId null) on the current
  // environment, and open+enlarge whatever it lands on.
  const jumpToAttention = (): void => {
    const target = nextNeedsYou(order, sessions, null, environment)
    if (target) openSession(target)
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
    environment,
    closeTerminal,
    openSession,
    switchEnvironment,
    moveToEnvironment
  })
  useEffect(() => {
    liveRef.current = {
      view,
      activeId,
      order,
      enlarged,
      sessions,
      environment,
      closeTerminal,
      openSession,
      switchEnvironment,
      moveToEnvironment
    }
  })

  useEffect(() => {
    // Refilled IN PLACE (not reassigned) so the stable onKey closure below
    // always reads the current set — this is the live-rebind path.
    const bindings: [KeyAction, ParsedBinding][] = []
    const loadBindings = (raw: Record<KeyAction, string>): void => {
      bindings.length = 0
      for (const [action, binding] of bindingEntries(raw)) {
        const parsed = parseBinding(binding)
        if (parsed) bindings.push([action, parsed])
      }
    }
    void window.localflow.getKeybindings().then(loadBindings)
    const offChanged = window.localflow.onKeybindingsChanged(loadBindings)

    // Capture phase: this dispatcher runs before terminal xterm instances
    // see the event, so it can claim bound combos (cmd+w, cmd+enter, ...)
    // that would otherwise be swallowed or misinterpreted by the terminal.
    // Unmatched events are left completely untouched, falling through to
    // whichever terminal has focus.
    const runAction = (action: KeyAction): void => {
      // go-up is available everywhere: shrink an enlarged pane, else leave
      // the environment view entirely. Same shrink-else-home semantics as
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
      // the environment view on the first waiting pane; inside the environment
      // view it cycles relative to the active pane. openSession supplies the
      // focus+enlarge semantics (enlarge only when there is more than one
      // session, same as clicking a row).
      if (action === 'focus-needs-you') {
        const live = liveRef.current
        const target = nextNeedsYou(
          live.order,
          live.sessions,
          live.view === 'environment' ? live.activeId : null,
          live.environment
        )
        if (target) live.openSession(target)
        return
      }
      if (action.startsWith('environment-')) {
        liveRef.current.switchEnvironment(Number(action.slice('environment-'.length)))
        return
      }

      // Everything else only acts within the environment view, on the active
      // pane — a no-op elsewhere (e.g. on the home/landing view).
      const live = liveRef.current
      if (live.view !== 'environment' || live.activeId === null) return
      const activeId = live.activeId

      if (action.startsWith('move-to-environment-')) {
        void live.moveToEnvironment(activeId, Number(action.slice('move-to-environment-'.length)))
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
    const onKey = (e: KeyboardEvent): void => {
      // While a keybinding capture is armed, the editor owns the keyboard —
      // a captured combo that is currently bound must not fire its action.
      if (document.documentElement.dataset.capturingKeybind === '1') return
      const match = bindings.find(([, binding]) => eventMatches(binding, e))
      if (!match) return
      e.preventDefault()
      e.stopPropagation()
      runAction(match[0])
    }
    const offForwarded = window.localflow.onKeyAction((action) => runAction(action))
    window.addEventListener('keydown', onKey, true)
    return () => {
      offChanged()
      offForwarded()
      window.removeEventListener('keydown', onKey, true)
    }
  }, [])

  useEffect(() => {
    const apply = (payload: { theme: Theme; error?: string }): void => {
      const vars = themeToCssVars(payload.theme)
      for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty(k, v)
      setTerminalTheme(themeToXterm(payload.theme))
      setThemeNotice(payload.error ?? null)
    }
    void window.localflow.getTheme().then(apply)
    const off = window.localflow.onThemeChanged(apply)
    return () => off()
  }, [])

  const showEnvironment =
    view === 'environment' && sessions.some((s) => s.environment === environment)
  const envSessions = sessions.filter((s) => s.environment === environment)
  // Shared by both the solo and grouped render paths below so a pane's
  // element is identical either way — grouping must not change a solo
  // pane's DOM (existing e2e selectors depend on that).
  const renderPane = (s: SessionInfo): React.JSX.Element =>
    s.kind === 'browser' ? (
      <BrowserPane
        key={s.id}
        session={s}
        enlarged={enlarged === s.id}
        active={activeId === s.id}
        onToggleEnlarge={() => setEnlarged((cur) => (cur === s.id ? null : s.id))}
        onActivate={() => setActiveId(s.id)}
        onReopen={() => void restart(s.id, false)}
        onClose={() => void closeTerminal(s.id)}
      />
    ) : (
      <TerminalPane
        key={s.id}
        session={s}
        enlarged={enlarged === s.id}
        active={activeId === s.id}
        onToggleEnlarge={() => setEnlarged((cur) => (cur === s.id ? null : s.id))}
        onActivate={() => setActiveId(s.id)}
        onRestart={(fresh) => void restart(s.id, fresh)}
        onClose={() => void closeTerminal(s.id)}
        terminalTheme={terminalTheme}
      />
    )

  return (
    <div className="flex min-h-0 flex-1">
      {themeNotice && (
        <div className="theme-notice fixed top-2 left-1/2 z-50 -translate-x-1/2 rounded-md border border-yellow-500/50 bg-yellow-500/15 px-3 py-1.5 text-[12px] text-yellow-200">
          {themeNotice}
          <button
            className="ml-3 cursor-pointer border-0 bg-transparent text-yellow-200/70 hover:text-white"
            onClick={() => setThemeNotice(null)}
            onMouseDown={(e) => e.preventDefault()}
          >
            dismiss
          </button>
        </div>
      )}
      {sidebarVisible && (
        <Sidebar
          sessions={sessions}
          view={
            showEnvironment
              ? 'environment'
              : view === 'settings'
                ? 'settings'
                : view === 'changes'
                  ? 'changes'
                  : view === 'activity'
                    ? 'activity'
                    : view === 'cockpit'
                      ? 'cockpit'
                      : 'home'
          }
          activeId={activeId}
          environment={environment}
          grantedEnvs={grantedEnvs}
          onSwitchEnvironment={switchEnvironment}
          onHome={() => setView('home')}
          onEnvironment={enterEnvironment}
          onActivity={enterActivity}
          onCockpit={enterCockpit}
          onSettings={() => setView('settings')}
          onChanges={enterChanges}
          onOpenSession={openSession}
          onDeleteSession={(id) => void deleteSession(id)}
          onRenameSession={(id, name) => void renameSession(id, name)}
        />
      )}
      {/* No content header: the sidebar IS the navigation (user decision
          2026-07-07); cmd+esc / nav items cover the old header buttons.
          relative: positioning context for .pane.enlarged (absolute, inset
          12px) so an enlarged pane fills only the content area and never
          covers the sidebar. */}
      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {showEnvironment ? (
          <div className="grid flex-1 auto-rows-[minmax(300px,1fr)] grid-cols-[repeat(auto-fit,minmax(460px,1fr))] gap-2.5 overflow-auto px-3 pt-3 pb-3">
            {groupedOrder(order, envSessions).map((run) => {
              // Solo pane: render exactly as before grouping existed — same
              // element, same position, zero DOM change.
              if (run.group === null) {
                const s = envSessions.find((p) => p.id === run.ids[0])
                return s ? renderPane(s) : null
              }
              const members = run.ids
                .map((id) => envSessions.find((p) => p.id === id))
                .filter((p): p is SessionInfo => p != null)
              const group = groups.find((g) => g.id === run.group)
              // Race guard: a group record not yet loaded (or emptied out)
              // must not drop its panes — fall back to rendering them solo.
              if (!group || members.length === 0) return members.map((s) => renderPane(s))
              return (
                <GroupBox
                  key={group.id}
                  group={group}
                  status={worstStatus(members.map((m) => m.status))}
                  onAddPane={() => {}}
                  onEnlargeSession={() => {}}
                >
                  {members.map((s) => renderPane(s))}
                </GroupBox>
              )
            })}
          </div>
        ) : view === 'changes' ? (
          <Changes
            sessions={sessions}
            sessionId={changesSessionId}
            onSelectSession={setChangesSessionId}
            onOpenLazygit={(id) => void openLazygit(id)}
          />
        ) : view === 'settings' ? (
          <Settings />
        ) : view === 'activity' ? (
          <Activity sessions={sessions} activeId={activeId} onOpenSession={openSession} />
        ) : view === 'cockpit' ? (
          <Cockpit environment={environment} />
        ) : (
          <Landing
            sessions={sessions}
            onCreate={(agentId, cmd) => void createSession(agentId, cmd)}
            onCreateBrowser={(url) => void createBrowser(url)}
            onOpen={openSession}
            onResume={(id, fresh) => void restart(id, fresh)}
            onDelete={(id) => void deleteSession(id)}
            onRename={(id, name) => void renameSession(id, name)}
            onOpenSettings={() => setView('settings')}
            onChanges={openChanges}
            onJumpToAttention={jumpToAttention}
          />
        )}
      </main>
    </div>
  )
}
