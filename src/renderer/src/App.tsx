import { useCallback, useEffect, useRef, useState } from 'react'
import TerminalPane from './components/TerminalPane'
import BrowserPane from './components/BrowserPane'
import GroupBox from './components/GroupBox'
import Breadcrumb from './components/Breadcrumb'
import AddPanePicker from './components/AddPanePicker'
import GroupPicker from './components/GroupPicker'
import Landing from './components/Landing'
import Settings from './components/Settings'
import Activity from './components/Activity'
import Sidebar from './components/Sidebar'
import Changes from './components/Changes'
import Cockpit from './components/Cockpit'
import { Console } from './components/Console'
import type { ConsoleEvent } from '../../shared/console'
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
import { nextFocusAfterClose, nextEnlargedAfterGone } from '../../shared/close-focus'
import type {
  AddPaneRequest,
  AgentId,
  AgentInfo,
  SessionGroup,
  SessionInfo
} from '../../shared/types'
import type { Capabilities } from '../../shared/git'
import {
  DEFAULT_THEME,
  themeToCssVars,
  themeToXterm,
  type Theme,
  type XtermTheme
} from '../../shared/theme'

// Enlarge staircase chrome sizing (M5 Task 6), single-sourced here so
// styles.css and the --enlarge-top math below can't drift apart the way two
// separately hand-maintained magic numbers eventually do. ENLARGE_PAD is the
// uniform inset .pane.enlarged / .group-enlarge-wrapper.enlarged keep on
// every side; CHROME_BAR_H is the fixed height of each chrome bar (the
// breadcrumb, and — when shown — the sibling strip below it) plus its 8px
// gap to whatever comes next. Plain CSS has no way to read these JS
// constants, so styles.css's .pane.enlarged / .enlarge-chrome /
// .group-enlarge-wrapper.enlarged rules keep their own literal 12px/30px/8px
// values in sync by hand — if you change the values here, update those too
// (search styles.css for "ENLARGE_PAD" / "CHROME_BAR_H").
export const ENLARGE_PAD = 12
export const CHROME_BAR_H = 38

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
  // `id` is always a PANE id, even at the 'session' level ("show every pane
  // of id's group side by side") — the staircase never needs a bare groupId.
  const [enlarged, setEnlarged] = useState<{ id: string; level: 'pane' | 'session' } | null>(null)
  // cmd+b hides the sidebar for a fullscreen-style focus mode.
  const [sidebarVisible, setSidebarVisible] = useState(true)
  // cmd+/ opens the bottom console drawer; works from any view.
  const [consoleOpen, setConsoleOpen] = useState(false)
  // Once the user toggles the drawer, the async prefs seed must not clobber
  // their choice (the seed IPC can resolve after an early keypress).
  const consoleTouched = useRef(false)
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
  // Escape-hatch tool availability (probed once and cached in main) — the
  // pane-header editor button disables itself with a hint, like Changes'.
  const [caps, setCaps] = useState<Capabilities | null>(null)
  const [editorNotice, setEditorNotice] = useState<string | null>(null)
  useEffect(() => {
    void window.localflow.getCapabilities().then(setCaps)
  }, [])
  // Which environments currently have an operator, for the sidebar indicator.
  const [grantedEnvs, setGrantedEnvs] = useState<Set<number>>(new Set())
  // Custom environment display names, keyed by environment number as a
  // string — same source and format Sidebar uses for its own environment
  // rows, reused here so the enlarge breadcrumb's envName matches exactly.
  const [envNames, setEnvNames] = useState<Record<string, string>>({})
  useEffect(() => {
    let cancelled = false
    void window.localflow.getEnvironmentNames().then((names) => {
      if (!cancelled) setEnvNames(names)
    })
    return () => {
      cancelled = true
    }
  }, [])
  // Agents for the add-pane picker (fetched once; Landing keeps its own copy
  // for the same list — separate concerns, no shared cache needed here).
  const [agents, setAgents] = useState<AgentInfo[]>([])
  useEffect(() => {
    let cancelled = false
    void window.localflow.listAgents().then((list) => {
      if (!cancelled) setAgents(list)
    })
    return () => {
      cancelled = true
    }
  }, [])
  // The source pane a companion is being added next to; non-null opens the
  // AddPanePicker modal. Opened from GroupBox's `+`, the enlarge chrome's
  // "spin up a pane here", or the add-pane keybinding on the focused pane.
  const [addPaneFor, setAddPaneFor] = useState<string | null>(null)
  // The pane being (re)grouped; non-null opens the GroupPicker modal, opened
  // by the group-pane keybinding on the focused pane.
  const [groupPaneFor, setGroupPaneFor] = useState<string | null>(null)
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
  // Same landing spot as createSession/createBrowser: jump into the
  // environment view on the first pane the template produced (main derives
  // cwd via the folder picker, so there's nothing else to pass through).
  const createTemplate = async (name: string): Promise<void> => {
    const created = await window.localflow.createTemplate(name, undefined, environment)
    if (created && created.length > 0) {
      setView('environment')
      setEnlarged(null)
      setActiveId(created[0].id)
      await refresh()
    }
  }
  // Adds a companion pane next to `sourceId` (main derives cwd/environment
  // from the source's own record — never trusted from here). Closes the
  // picker regardless of outcome; a null result (unknown source, invalid
  // request) is simply a no-op beyond that.
  const addPane = async (sourceId: string, req: AddPaneRequest): Promise<void> => {
    setAddPaneFor(null)
    const created = await window.localflow.addPane(sourceId, req)
    if (created) {
      setActiveId(created.id)
      await refresh()
    }
  }
  // Moves `paneId` into an existing group, or a brand-new one named after
  // the pane ('new'). Closes the picker regardless of outcome; a null
  // createGroup (pane name somehow empty) is a no-op beyond that, same as
  // addPane's unknown-source handling.
  const assignPaneToGroup = async (paneId: string, target: string | 'new'): Promise<void> => {
    setGroupPaneFor(null)
    let groupId: string | null
    if (target === 'new') {
      const pane = sessions.find((s) => s.id === paneId)
      if (!pane) return
      const created = await window.localflow.createGroup(pane.name, pane.environment)
      if (!created) return
      groupId = created.id
    } else {
      groupId = target
    }
    const updated = await window.localflow.assignToGroup(paneId, groupId)
    if (updated) await refresh()
  }
  // No-op on an already-ungrouped pane — assignToGroup always records a
  // 'moved' activity entry, so calling it unconditionally would spam the
  // log for a keybinding that did nothing.
  const ungroupPane = async (paneId: string): Promise<void> => {
    const pane = sessions.find((s) => s.id === paneId)
    if (!pane?.groupId) return
    const updated = await window.localflow.assignToGroup(paneId, null)
    if (updated) await refresh()
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
  // can no longer hold keyboard focus. A session-level enlarge survives if a
  // group sibling is still standing (nextEnlargedAfterGone reassigns the
  // anchor to it); otherwise it collapses to the grid same as a pane-level
  // enlarge always does. Uses the pre-refresh `sessions` snapshot, which
  // still holds `id`'s own record — needed to recover its groupId.
  const afterPaneGone = async (id: string): Promise<void> => {
    setEnlarged((cur) => nextEnlargedAfterGone(cur, id, sessions))
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
    setEnlarged(sessions.length > 1 ? { id, level: 'pane' } : null)
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
  // "Open in editor": main launches the configured editor on the session's
  // cwd as an external app — no pane, no navigation. A false return means the
  // editor didn't launch; surface main's availability hint as a notice (the
  // keybinding path has no disabled button to explain itself).
  const openEditor = async (sessionId: string): Promise<void> => {
    if (await window.localflow.openEditor(sessionId)) return
    const current = await window.localflow.getCapabilities()
    setCaps(current)
    setEditorNotice(
      current.editor.hint ?? `Couldn't open the configured editor (${current.editor.command})`
    )
  }
  const enterActivity = (): void => setView('activity')
  const enterCockpit = (): void => setView('cockpit')
  // Console row "open source": reflect-and-replay, not navigation-by-guess —
  // a status row jumps to its session (same focus semantics as clicking it
  // in the sidebar); operator/capture rows have no single pane to jump to,
  // so they open the cockpit for the row's environment instead.
  const openConsoleSource = (event: ConsoleEvent): void => {
    if (event.detail.source === 'status') {
      if (event.sessionId) openSession(event.sessionId)
      return
    }
    setEnvironment(event.environment)
    setView('cockpit')
  }
  // Console row "rerun watchpoint": capture rows only. Re-arms the SAME
  // workflow/step/capture-kinds the original watchpoint was registered
  // with, via the existing operator watchpoint registration IPC — this is a
  // replay of an existing watch, never request composition (the drawer
  // stays show-not-author).
  const rerunWatchpoint = async (event: ConsoleEvent): Promise<void> => {
    if (event.detail.source !== 'capture') return
    const watchpointId = event.detail.watchpointId
    const watchpoints = await window.localflow.listWatchpoints(event.environment)
    const wp = watchpoints.find((w) => w.id === watchpointId)
    if (!wp) return
    await window.localflow.registerWatchpoint(event.environment, wp.workflow, wp.step, wp.capture)
  }
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
      cur !== null && sessions.find((s) => s.id === cur.id)?.environment === target ? cur : null
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
    // focus (and next enlarge anchor) from the list refresh() just fetched
    // (not the `sessions` state, which won't reflect this refresh until the
    // next render), scoped to this environment — by then every moved
    // sibling is correctly gone, so a session-level enlarge on the moved
    // group naturally collapses (nextEnlargedAfterGone finds no sibling to
    // reassign to) rather than following the group off-screen.
    const list = await refresh()
    const scoped = list.filter((s) => s.environment === environment)
    setEnlarged((cur) => nextEnlargedAfterGone(cur, id, scoped))
    setActiveId((cur) => {
      if (cur !== id) return cur
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
    openEditor,
    switchEnvironment,
    moveToEnvironment,
    ungroupPane
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
      openEditor,
      switchEnvironment,
      moveToEnvironment,
      ungroupPane
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
      // go-up is available everywhere: walk the enlarge staircase down one
      // step at a time ('session' -> 'pane' -> null), and only once nothing
      // is enlarged does it fall through to leaving the environment view
      // entirely — the same go-home semantics as before this became a bound
      // action, preserved verbatim for the already-shrunk case.
      if (action === 'go-up') {
        setEnlarged((cur) => {
          if (cur === null) {
            setView('home')
            return cur
          }
          if (cur.level === 'session') return { id: cur.id, level: 'pane' }
          return null
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
      if (action === 'console-toggle') {
        consoleTouched.current = true
        setConsoleOpen((v) => !v)
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
      // Cycle: null -> {active, 'pane'} -> (grouped ? 'session' : null) ->
      // null. A solo pane (no groupId) skips the session level entirely, so
      // two toggles always return it to the plain grid.
      if (action === 'enlarge-toggle') {
        setEnlarged((cur) => {
          if (cur === null) return { id: activeId, level: 'pane' }
          if (cur.level === 'session') return null
          const pane = live.sessions.find((s) => s.id === cur.id)
          return pane?.groupId ? { id: cur.id, level: 'session' } : null
        })
        return
      }
      if (action === 'close-pane') {
        void live.closeTerminal(activeId)
        return
      }
      if (action === 'add-pane') {
        setAddPaneFor(activeId)
        return
      }
      if (action === 'group-pane') {
        setGroupPaneFor(activeId)
        return
      }
      if (action === 'ungroup-pane') {
        void live.ungroupPane(activeId)
        return
      }
      // Browser panes have no working tree — the combo is a quiet no-op there
      // rather than a misleading "couldn't open" notice.
      if (action === 'open-editor') {
        const target = live.sessions.find((s) => s.id === activeId)
        if (target && target.kind !== 'browser') void live.openEditor(activeId)
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

  // Seed the drawer's open state once at startup; Console.tsx owns the rest
  // of the prefs (height, sources, text) since it's already the sole reader.
  useEffect(() => {
    let alive = true
    void window.localflow.getConsolePrefs().then((prefs) => {
      if (alive && !consoleTouched.current) setConsoleOpen(prefs.open)
    })
    return () => {
      alive = false
    }
  }, [])

  const showEnvironment =
    view === 'environment' && sessions.some((s) => s.environment === environment)
  const envSessions = sessions.filter((s) => s.environment === environment)
  // Environment label, same "N" / "N · customName" convention as Sidebar's
  // own environment rows (fed by the same getEnvironmentNames map) — reused
  // here for the enlarge breadcrumb's envName.
  const envLabel = (n: number): string =>
    `${n}${envNames[String(n)] ? ` · ${envNames[String(n)]}` : ''}`
  // The pane/group the enlarge staircase currently shows, if any — derived
  // once so the breadcrumb, sibling strip and the --enlarge-top chrome
  // offset all read the same truth. enlarged.id is always a pane id, even at
  // the 'session' level.
  const enlargedPane = enlarged ? (sessions.find((s) => s.id === enlarged.id) ?? null) : null
  const enlargedGroup =
    enlargedPane?.groupId != null
      ? (groups.find((g) => g.id === enlargedPane.groupId) ?? null)
      : null
  const enlargedGroupMembers = enlargedGroup
    ? order
        .map((id) => envSessions.find((s) => s.id === id))
        .filter((s): s is SessionInfo => s != null && s.groupId === enlargedGroup.id)
    : []
  const showSiblingStrip = enlarged?.level === 'pane' && enlargedGroup !== null
  // .enlarge-topbar and .sibling-strip are each CHROME_BAR_H tall including
  // their gap (see styles.css) — reserved here, in px, as --enlarge-top so
  // .pane.enlarged / .group-enlarge-wrapper.enlarged never render underneath
  // the chrome bar(s) sitting on top of them. ENLARGE_PAD / CHROME_BAR_H are
  // defined once near the top of this file.
  const enlargeTop = enlarged
    ? ENLARGE_PAD + CHROME_BAR_H + (showSiblingStrip ? CHROME_BAR_H : 0)
    : ENLARGE_PAD
  // Pane-level enlarge toggle for a single pane id: enlarge it, or collapse
  // back to the grid if it's already the pane-level anchor. Shared by both
  // renderPane branches so the two identical closures can't drift.
  const togglePane = (id: string): void =>
    setEnlarged((cur) => (cur?.level === 'pane' && cur.id === id ? null : { id, level: 'pane' }))
  // Shared by both the solo and grouped render paths below so a pane's
  // element is identical either way — grouping must not change a solo
  // pane's DOM (existing e2e selectors depend on that).
  const renderPane = (s: SessionInfo): React.JSX.Element =>
    s.kind === 'browser' ? (
      <BrowserPane
        key={s.id}
        session={s}
        enlarged={enlarged?.level === 'pane' && enlarged.id === s.id}
        active={activeId === s.id}
        onToggleEnlarge={() => togglePane(s.id)}
        onActivate={() => setActiveId(s.id)}
        onReopen={() => void restart(s.id, false)}
        onClose={() => void closeTerminal(s.id)}
      />
    ) : (
      <TerminalPane
        key={s.id}
        session={s}
        enlarged={enlarged?.level === 'pane' && enlarged.id === s.id}
        active={activeId === s.id}
        onToggleEnlarge={() => togglePane(s.id)}
        onActivate={() => setActiveId(s.id)}
        onRestart={(fresh) => void restart(s.id, fresh)}
        onClose={() => void closeTerminal(s.id)}
        onOpenEditor={() => void openEditor(s.id)}
        editor={caps?.editor ?? null}
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
      {editorNotice && (
        <div className="editor-notice fixed top-12 left-1/2 z-50 -translate-x-1/2 rounded-md border border-yellow-500/50 bg-yellow-500/15 px-3 py-1.5 text-[12px] text-yellow-200">
          {editorNotice}
          <button
            className="ml-3 cursor-pointer border-0 bg-transparent text-yellow-200/70 hover:text-white"
            onClick={() => setEditorNotice(null)}
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
          relative: positioning context for .pane.enlarged and
          .group-enlarge-wrapper.enlarged (absolute, inset 12px on every side
          but top, which reserves --enlarge-top for the breadcrumb/sibling-
          strip chrome above them) so an enlarge fills only the content area
          and never covers the sidebar. */}
      <main
        className="relative flex min-h-0 min-w-0 flex-1 flex-col"
        style={{ '--enlarge-top': `${enlargeTop}px` } as React.CSSProperties}
      >
        {showEnvironment ? (
          <>
            <div className="grid flex-1 auto-rows-[minmax(300px,1fr)] grid-cols-[repeat(auto-fit,minmax(460px,1fr))] gap-2.5 overflow-auto px-3 pt-3 pb-3">
              {groupedOrder(order, envSessions).map((run) => {
                // Solo pane: render exactly as before grouping existed — same
                // element, same position, zero DOM change.
                // Known remount: grouping/ungrouping a SOLO pane flips it
                // between this branch and the wrapped `group-enlarge-wrapper`
                // branch below, changing its DOM ancestry — React unmounts
                // and remounts its TerminalPane (xterm scrollback resets;
                // the pty itself survives in main). Unlike the enlarge-level
                // switch below (which is remount-safe by design), this
                // transition is not — don't assume solo→grouped is seamless.
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
                // Always wrapped, regardless of enlarge state — the wrapper
                // is `display: contents` (a no-op in the grid) until this
                // group is session-enlarged, at which point CSS alone turns
                // it into the absolutely-positioned surface. The member
                // panes below never change tree position, so they never
                // unmount/remount (xterm + pty state survives) switching in
                // or out of the session level.
                const isSessionEnlarged =
                  enlarged?.level === 'session' && enlargedGroup?.id === group.id
                return (
                  <div
                    key={group.id}
                    className={'group-enlarge-wrapper' + (isSessionEnlarged ? ' enlarged' : '')}
                  >
                    <GroupBox
                      group={group}
                      status={worstStatus(members.map((m) => m.status))}
                      // Session-enlarged: the breadcrumb already names the
                      // group, so collapse this now-redundant (and inert)
                      // header. Grid header stays exactly as before.
                      headerHidden={isSessionEnlarged}
                      onAddPane={() => setAddPaneFor(members[0].id)}
                      onEnlargeSession={() => {
                        setEnlarged({ id: members[0].id, level: 'session' })
                        setActiveId(members[0].id)
                      }}
                    >
                      {members.map((s) => renderPane(s))}
                    </GroupBox>
                  </div>
                )
              })}
            </div>
            {enlarged && (
              <div className="enlarge-chrome">
                <div className="enlarge-topbar pane-header flex h-[30px] items-center gap-2 bg-white/[0.04] px-2.5 text-xs select-none">
                  <Breadcrumb
                    envName={envLabel(environment)}
                    groupName={enlargedGroup?.name}
                    paneName={enlarged.level === 'pane' ? enlargedPane?.name : undefined}
                  />
                  <button
                    className="spin-up-pane cursor-pointer border-0 bg-transparent text-xs text-gray-400 hover:text-white"
                    onClick={() => setAddPaneFor(enlarged.id)}
                    onMouseDown={(e) => e.preventDefault()}
                  >
                    spin up a pane here
                  </button>
                </div>
                {showSiblingStrip && (
                  <div className="sibling-strip flex h-[30px] items-center gap-1 overflow-x-auto bg-white/[0.04] px-2.5">
                    {enlargedGroupMembers.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        data-pane-id={m.id}
                        className={
                          'sibling-tab flex cursor-pointer items-center gap-1.5 rounded border-0 bg-transparent px-2 py-1 text-xs text-gray-400 hover:text-white' +
                          (m.id === enlarged.id ? ' active text-white' : '')
                        }
                        onClick={() => {
                          setEnlarged({ id: m.id, level: 'pane' })
                          setActiveId(m.id)
                        }}
                        onMouseDown={(e) => e.preventDefault()}
                      >
                        <span
                          className="dot h-2 w-2 flex-none rounded-full"
                          data-status={m.status}
                        />
                        {m.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
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
            onCreateTemplate={(name) => void createTemplate(name)}
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
      {addPaneFor && (
        <AddPanePicker
          agents={agents}
          onCancel={() => setAddPaneFor(null)}
          onPick={(req) => void addPane(addPaneFor, req)}
        />
      )}
      {groupPaneFor &&
        (() => {
          const pane = sessions.find((s) => s.id === groupPaneFor)
          const candidates = groups.filter(
            (g) => g.environment === pane?.environment && g.id !== pane?.groupId
          )
          return (
            <GroupPicker
              groups={candidates}
              onCancel={() => setGroupPaneFor(null)}
              onPick={(target) => void assignPaneToGroup(groupPaneFor, target)}
            />
          )
        })()}
      <Console
        open={consoleOpen}
        onClose={() => {
          consoleTouched.current = true
          setConsoleOpen(false)
        }}
        focus={{ view, enlarged, environment }}
        onOpenSource={openConsoleSource}
        onRerunWatchpoint={(event) => void rerunWatchpoint(event)}
      />
    </div>
  )
}
