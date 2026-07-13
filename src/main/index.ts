import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { join } from 'node:path'
import { existsSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import type { AgentId, AgentOverride, AgentOverrideResult } from '../shared/types'
import { clampEnvironment } from '../shared/environment'
import { normalizeHttpUrl, isHttpUrl } from '../shared/urls'
import { startHookServer } from './hook-server'
import { SessionManager, type SpawnSpec } from './session-manager'
import { loadSavedState, saveState } from './persistence'
import { AgentRegistry, whichViaLoginShell } from './agent-registry'
import { ensureThemesSeeded, listThemeNames, resolveTheme } from './theme-store'
import { loadOrCreateKeybindings, writeKeybindings } from './keybindings-file'
import { loadEnvironmentNames } from './environment-names'
import { installWebviewPolicy } from './webview-policy'
import { gitStatus, gitDiff } from './git'
import { describeTool, gateBin } from './tools'
import { loadEditorCommand } from './editor-config'
import { splitCommandLine } from '../shared/args'
import { PaneRegistry } from './pane-registry'
import { OperatorGrantStore } from './operator-grant'
import { credentialEnv, OperatorLaunchTracker } from './operator-launch'
import { startControlServer } from './control-api'
import { BrowserBridge } from './browser-bridge'
import { WebviewBrowserControl } from './browser-control'
import { CaptureStore } from './capture-store'
import { WatchpointRegistry } from './watchpoints'
import type { ActivityEntry, GrantInfo, OperatorStatus } from '../shared/operator'
import type { Capabilities } from '../shared/git'
import {
  DEFAULT_BINDINGS,
  applyBindingChange,
  type BindingChangeResult,
  type KeyAction
} from '../shared/keybindings'

if (process.env['LOCALFLOW_USER_DATA']) {
  app.setPath('userData', process.env['LOCALFLOW_USER_DATA'])
}

const VALID_AGENTS: AgentId[] = ['claude', 'codex', 'gemini', 'openclaw', 'shell', 'custom']

let win: BrowserWindow | null = null
let managerRef: SessionManager | null = null

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'localflow',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Browser panes use the <webview> tag: it participates in DOM layout
      // (grid/enlarge/focus need no special-casing, unlike WebContentsView).
      // Guest pages are locked down in installWebviewPolicy.
      webviewTag: true
    }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * Electron's default application menu binds cmd+w to Close Window, cmd+h
 * to Hide and cmd+m to Minimize. localflow owns those as in-app pane keys
 * (close-pane, focus-left, enlarge-toggle), so the menu must not carry
 * those accelerators.
 */
function buildAppMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      role: 'appMenu',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        // Not role: 'hide' — Electron treats `accelerator: undefined` on a
        // role item as omitted and applies the role default (Cmd+H), which
        // must stay free for the in-app focus-left key.
        { label: 'Hide localflow', click: () => app.hide() },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    {
      label: 'Window',
      submenu: [
        // Not role: 'minimize' — its role default (Cmd+M) must stay free
        // for the in-app enlarge-toggle key.
        { label: 'Minimize', click: () => BrowserWindow.getFocusedWindow()?.minimize() },
        { role: 'zoom' }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(async () => {
  buildAppMenu()

  // Dev-mode dock icon (packaged builds get it from build/icon.png via
  // electron-builder; in dev Electron shows its default logo otherwise).
  if (!app.isPackaged && process.platform === 'darwin') {
    const devIcon = join(__dirname, '../../assets/icon-512.png')
    if (existsSync(devIcon)) app.dock?.setIcon(devIcon)
  }

  const userData = app.getPath('userData')
  const sessionsFile = join(userData, 'sessions.json')
  let keybindings = loadOrCreateKeybindings(join(userData, 'keybindings.json'))

  const registry = new AgentRegistry(
    join(userData, 'config.json'),
    undefined,
    process.env['LOCALFLOW_CLAUDE_BIN'],
    process.env['LOCALFLOW_OPENCLAW_BIN']
  )

  const themesDir = join(userData, 'themes')
  ensureThemesSeeded(themesDir)

  const endpoint = await startHookServer((e) => manager.applyHookEvent(e))
  if (process.env['LOCALFLOW_E2E'] === '1') {
    writeFileSync(
      join(userData, 'endpoint.json'),
      JSON.stringify({ port: endpoint.port, token: endpoint.token }),
      { mode: 0o600 }
    )
  }

  const manager = new SessionManager({
    settingsDir: userData,
    port: endpoint.port,
    token: endpoint.token
  })
  managerRef = manager

  const specFor = (agentId: AgentId, customCommand?: string): SpawnSpec => ({
    agentId,
    command: registry.commandFor(agentId, customCommand),
    resumeArgs: registry.argsFor(agentId, true),
    hookAdapter: registry.hookAdapter(agentId),
    extraArgs: registry.extraArgsFor(agentId),
    env: registry.envFor(agentId)
  })

  // A destroyed BrowserWindow still non-null: guard every send, because pty
  // output keeps streaming while the app tears down (crash: "Object has been
  // destroyed" dialogs during quit/reload otherwise).
  const sendToWindow = (channel: string, ...args: unknown[]): void => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
  }

  const grants = new OperatorGrantStore()
  // Named paneRegistry, not registry — `registry` above is already the
  // AgentRegistry instance used throughout this scope.
  const paneRegistry = new PaneRegistry(manager)
  // Rolling per-environment action log (newest last, capped). In-memory only —
  // the feed is deliberately not persisted across restarts (spec "Out of scope").
  const activity = new Map<number, ActivityEntry[]>()

  const browserBridge = new BrowserBridge()
  const captureStore = new CaptureStore(join(userData, 'captures'))
  const browserControl = new WebviewBrowserControl(browserBridge, captureStore)
  const watchpoints = new WatchpointRegistry()

  const control = await startControlServer({
    registry: paneRegistry,
    grants,
    manager,
    browser: browserControl,
    captures: captureStore,
    watchpoints,
    onActivity: (env, entry) => {
      const log = activity.get(env) ?? []
      log.push(entry)
      if (log.length > 200) log.splice(0, log.length - 200)
      activity.set(env, log)
      sendToWindow('operator:activity', env, entry)
    }
  })
  app.on('before-quit', () => {
    control.close()
    // The scratch dir only holds handoff assets for live sessions; nothing in
    // it is meaningful across a restart (captures themselves are in-memory).
    captureStore.clear()
  })
  const launchTracker = new OperatorLaunchTracker()

  ipcMain.on('browser:register', (_e, handle: string, webContentsId: number) => {
    if (typeof handle === 'string' && Number.isInteger(webContentsId)) {
      browserBridge.register(handle, webContentsId)
    }
  })
  ipcMain.on('browser:unregister', (_e, handle: string) => {
    if (typeof handle === 'string') browserBridge.unregister(handle)
  })

  const webviewPolicy = installWebviewPolicy({
    bindings: keybindings,
    onAction: (action) => sendToWindow('keybinding:action', action)
  })

  manager.onData((id, data) => sendToWindow('session:data', id, data))
  manager.onStatus((id, status) => sendToWindow('session:status', id, status))
  manager.onActivity((id, entry) => sendToWindow('activity:event', id, entry))
  manager.onSessionsChanged(() => {
    const currentIds = new Set(manager.list().map((s) => s.id))
    for (const id of launchTracker.trackedIds()) {
      if (!currentIds.has(id)) {
        const env = launchTracker.onClose(id)
        if (env !== null) grants.revoke(env)
      }
    }
    saveState(sessionsFile, {
      sessions: manager
        .list()
        .map(({ id, cwd, agentId, command, name, environment, kind, url, groupId }) => ({
          id,
          cwd,
          agentId,
          command,
          name,
          environment,
          kind,
          url,
          groupId
        })),
      groups: manager.listGroups()
    })
  })

  const savedState = loadSavedState(sessionsFile)
  manager.restoreGroups(savedState.groups)
  for (const saved of savedState.sessions) {
    if (saved.kind === 'browser') {
      // restoreBrowser validates the stored URL; a hand-corrupted entry is
      // dropped rather than restored as an unloadable pane.
      manager.restoreBrowser(
        saved.id,
        saved.url ?? '',
        saved.name,
        saved.environment,
        saved.groupId
      )
      continue
    }
    const agentId = VALID_AGENTS.includes(saved.agentId as AgentId)
      ? (saved.agentId as AgentId)
      : 'claude'
    // A saved custom session keeps its stored command verbatim.
    const spec = agentId === 'custom' ? specFor(agentId, saved.command ?? '') : specFor(agentId)
    manager.restore(saved.id, saved.cwd, spec, saved.name, saved.environment, saved.groupId)
  }

  ipcMain.handle(
    'session:create',
    async (_e, agentId: AgentId, cwd?: string, customCommand?: string, environment?: number) => {
      if (!VALID_AGENTS.includes(agentId)) return null
      if (agentId === 'custom' && !customCommand?.trim()) return null
      let dir = process.env['LOCALFLOW_E2E'] === '1' ? cwd : undefined
      if (!dir) {
        const result = await dialog.showOpenDialog(win!, {
          properties: ['openDirectory', 'createDirectory'],
          title: 'Choose a project folder for the new session'
        })
        if (result.canceled || result.filePaths.length === 0) return null
        dir = result.filePaths[0]
      }
      let spec = specFor(agentId, customCommand?.trim())
      let launch: { environment: number; wasGranted: boolean } | null = null
      if (agentId === 'openclaw') {
        const env = clampEnvironment(environment)
        const wasGranted = grants.isGranted(env)
        const token = grants.grant(env)
        spec = {
          ...spec,
          env: { ...spec.env, ...credentialEnv(`http://127.0.0.1:${control.port}`, token) }
        }
        launch = { environment: env, wasGranted }
      }
      const created = manager.create(dir, spec, clampEnvironment(environment))
      if (launch) launchTracker.onLaunch(launch.environment, created.id, launch.wasGranted)
      if (created.status !== 'exited') {
        registry.recordLastAgent(agentId, customCommand?.trim())
      }
      return created
    }
  )
  ipcMain.handle('session:restart', (_e, id: string, fresh?: boolean) =>
    manager.restart(id, fresh === true)
  )
  ipcMain.handle('session:closeTerminal', (_e, id: string) => manager.closeTerminal(id))
  ipcMain.handle('session:delete', (_e, id: string) => manager.deleteSession(id))
  ipcMain.handle('session:rename', (_e, id: string, name: string) => manager.rename(id, name))
  ipcMain.handle('session:setEnvironment', (_e, id: string, environment: number) =>
    manager.setEnvironment(id, environment)
  )
  ipcMain.handle('group:create', (_e, name: string, environment: number) =>
    typeof name === 'string' && name.trim().length > 0
      ? manager.createGroup(name, environment)
      : null
  )
  ipcMain.handle('group:rename', (_e, id: string, name: string) =>
    typeof id === 'string' && typeof name === 'string' ? manager.renameGroup(id, name) : null
  )
  ipcMain.handle('group:assign', (_e, paneId: string, groupId: string | null) =>
    typeof paneId === 'string' && (groupId === null || typeof groupId === 'string')
      ? manager.assignToGroup(paneId, groupId)
      : null
  )
  ipcMain.handle('group:list', () => manager.listGroups())
  ipcMain.handle('session:createBrowser', (_e, url: string, environment?: number) => {
    // Validate at the boundary; manager.createBrowser re-validates (throws),
    // so reject cleanly here instead of surfacing an exception to the bridge.
    if (typeof url !== 'string' || normalizeHttpUrl(url) === null) return null
    return manager.createBrowser(url, clampEnvironment(environment))
  })
  ipcMain.handle('session:setUrl', (_e, id: string, url: string) =>
    typeof url === 'string' ? manager.setUrl(id, url) : null
  )
  ipcMain.handle('git:status', (_e, id: string) => {
    // cwd is resolved from the session record here — NEVER trusted from the
    // renderer. Browser panes (and unknown ids) have no working tree.
    const s = manager.get(id)
    if (!s || s.kind !== 'terminal') return { repo: false }
    return gitStatus(s.cwd)
  })
  ipcMain.handle('git:diff', (_e, id: string, path: string, staged: boolean) => {
    const s = manager.get(id)
    if (!s || s.kind !== 'terminal' || typeof path !== 'string') {
      return { text: '', truncated: false }
    }
    return gitDiff(s.cwd, path, staged === true)
  })

  // Escape-hatch tool resolution. An absolute-path env override is honored via
  // existsSync (tests point these at nonexistent/fixture paths so the suite
  // never spawns a real login shell). Otherwise the token is security-gated
  // first: whichViaLoginShell interpolates its argument into a shell line
  // (`$SHELL -ilc "command -v ${bin}"`), so only vetted tokens may reach it —
  // absolute paths (spaces fine) are checked with existsSync and never touch a
  // shell; strict safe-identifier names get the login-shell PATH lookup a GUI
  // app needs; anything else (config.json is user-edited) is unresolvable.
  const resolveTool = (bin: string, override?: string): Promise<string | null> => {
    if (override) return Promise.resolve(existsSync(override) ? override : null)
    switch (gateBin(bin)) {
      case 'absolute':
        return Promise.resolve(existsSync(bin) ? bin : null)
      case 'login-shell':
        return whichViaLoginShell(bin)
      case 'rejected':
        return Promise.resolve(null)
    }
  }

  // Probed once and cached: a login-shell lookup is expensive, and the Changes
  // view re-enters often. Newly installed tools / edited editorCommand apply on
  // next launch — same resolution-caching trade-off AgentRegistry makes.
  let capsCache: Capabilities | null = null
  ipcMain.handle('git:capabilities', async (): Promise<Capabilities> => {
    if (capsCache) return capsCache
    const editorCommand = loadEditorCommand(join(userData, 'config.json'))
    // Quote-aware split: null (unbalanced quote) or an empty first token means
    // the configured command is unusable — report the editor unavailable.
    const editorBin = splitCommandLine(editorCommand)?.[0] || null
    const [lazygitPath, editorPath] = await Promise.all([
      resolveTool('lazygit', process.env['LOCALFLOW_LAZYGIT_BIN']),
      editorBin
        ? resolveTool(editorBin, process.env['LOCALFLOW_EDITOR_BIN'])
        : Promise.resolve<string | null>(null)
    ])
    capsCache = {
      lazygit: describeTool('lazygit', lazygitPath),
      editor: { ...describeTool(editorBin ?? editorCommand, editorPath), command: editorCommand }
    }
    return capsCache
  })

  ipcMain.handle('git:openLazygit', async (_e, id: string) => {
    const s = manager.get(id)
    if (!s || s.kind !== 'terminal' || !s.cwd) return null
    const lazygitPath = await resolveTool('lazygit', process.env['LOCALFLOW_LAZYGIT_BIN'])
    if (!lazygitPath) return null
    // Reuse the custom-agent plumbing verbatim: a durable custom session running
    // lazygit (by resolved absolute path — a GUI app's env lacks the login PATH)
    // in the reviewed session's OWN cwd + environment. cwd comes from the record.
    return manager.create(s.cwd, specFor('custom', lazygitPath), s.environment)
  })

  ipcMain.handle('git:openEditor', async (_e, id: string) => {
    const s = manager.get(id)
    if (!s || s.kind !== 'terminal' || !s.cwd) return false
    const parts = splitCommandLine(loadEditorCommand(join(userData, 'config.json')))
    const bin = parts?.[0]
    if (!parts || !bin) return false
    const resolved = await resolveTool(bin, process.env['LOCALFLOW_EDITOR_BIN'])
    if (!resolved) return false
    try {
      // External, detached, fire-and-forget process — never a pane. stdio
      // ignored + unref so it can neither hold quit nor be killed by our pipe
      // lifetime; async spawn failures get a log line instead of vanishing.
      const child = spawn(resolved, [...parts.slice(1), s.cwd], {
        cwd: s.cwd,
        detached: true,
        stdio: 'ignore'
      })
      child.on('error', (err) => console.error('editor launch failed', err))
      child.unref()
    } catch {
      return false
    }
    return true
  })

  ipcMain.handle('session:list', () => manager.list())
  ipcMain.handle('activity:get', (_e, id: string) => manager.getActivity(id))
  ipcMain.handle('session:peek', (_e, id: string, maxLines?: number) => {
    // Clamp at the boundary: the renderer is not trusted with the range.
    const n = Number(maxLines)
    return manager.peek(id, Math.min(Math.max(Number.isFinite(n) ? Math.trunc(n) : 5, 1), 20))
  })
  ipcMain.on('session:write', (_e, id: string, data: string) => manager.write(id, data))
  ipcMain.on('session:resize', (_e, id: string, cols: number, rows: number) =>
    manager.resize(id, cols, rows)
  )
  ipcMain.on('shell:openExternal', (_e, url: string) => {
    if (typeof url === 'string' && isHttpUrl(url)) void shell.openExternal(url)
  })

  ipcMain.handle('keybindings:get', () => keybindings)

  // One write path for every keybinding change: persist (hand-editable file
  // stays the source of truth), update the in-memory copy, re-point the
  // webview key-forwarder, and push the full map so the renderer dispatcher
  // re-parses. No restart.
  const applyKeybindings = (next: Record<KeyAction, string>): Record<KeyAction, string> => {
    keybindings = next
    writeKeybindings(join(userData, 'keybindings.json'), next)
    webviewPolicy.updateBindings(next)
    sendToWindow('keybindings:changed', next)
    return next
  }
  ipcMain.handle('keybindings:set', (_e, action: string, binding: string): BindingChangeResult => {
    if (!(action in DEFAULT_BINDINGS) || typeof binding !== 'string') {
      return { ok: false, reason: 'invalid', conflicts: [] }
    }
    // Conflicts are rejected here, not just surfaced in the UI: main's IPC is
    // the gatekeeper for keybindings.json, so no caller can persist a combo
    // another action already holds. A no-op re-set skips the write + push.
    const result = applyBindingChange(keybindings, action as KeyAction, binding)
    if (result.ok && result.changed) applyKeybindings(result.bindings)
    return result
  })
  ipcMain.handle('keybindings:reset', (_e, action: string) => {
    if (!(action in DEFAULT_BINDINGS)) return keybindings
    return applyKeybindings({
      ...keybindings,
      [action as KeyAction]: DEFAULT_BINDINGS[action as KeyAction]
    })
  })
  ipcMain.handle('keybindings:resetAll', () => applyKeybindings({ ...DEFAULT_BINDINGS }))
  ipcMain.handle('environments:getNames', () => loadEnvironmentNames(join(userData, 'config.json')))

  ipcMain.handle('agents:list', () => registry.list())
  ipcMain.handle('agents:getLastAgent', () => registry.getLastAgent())
  ipcMain.handle('agents:setPath', async (_e, agentId: AgentId) => {
    if (!VALID_AGENTS.includes(agentId) || agentId === 'custom') return null
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openFile'],
      title: 'Locate the agent executable'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    registry.setPath(agentId, result.filePaths[0])
    return registry.list()
  })
  ipcMain.handle('operator:grant', (_e, environment: number): GrantInfo => {
    const env = clampEnvironment(environment)
    const token = grants.grant(env)
    const info: GrantInfo = {
      environment: env,
      endpoint: `http://127.0.0.1:${control.port}`,
      token
    }
    // Under e2e, expose the grant to the scripted control-API client on disk
    // (mirrors the hook server's endpoint.json handshake).
    if (process.env['LOCALFLOW_E2E'] === '1') {
      writeFileSync(join(userData, `operator-grant-${env}.json`), JSON.stringify(info), {
        mode: 0o600
      })
    }
    return info
  })
  ipcMain.handle('operator:revoke', (_e, environment: number) => {
    grants.revoke(clampEnvironment(environment))
  })
  ipcMain.handle('operator:status', (_e, environment: number): OperatorStatus => {
    const env = clampEnvironment(environment)
    return {
      environment: env,
      granted: grants.isGranted(env),
      connected: grants.isConnected(env),
      endpoint: grants.isGranted(env) ? `http://127.0.0.1:${control.port}` : undefined,
      activity: activity.get(env) ?? []
    }
  })
  ipcMain.handle('operator:captures', (_e, environment: number) =>
    captureStore.list(clampEnvironment(environment))
  )
  ipcMain.handle('operator:watchpoints', (_e, environment: number) =>
    watchpoints.list(clampEnvironment(environment))
  )
  ipcMain.handle(
    'operator:resume',
    (_e, environment: number, captureId: string, approve: boolean) => {
      const env = clampEnvironment(environment)
      const token = captureStore.resolve(env, captureId)
      const log = activity.get(env) ?? []
      log.push({
        at: Date.now(),
        route: 'operator:resume',
        detail: `${captureId} ${approve ? 'approve' : 'stop'}`
      })
      if (log.length > 200) log.splice(0, log.length - 200)
      activity.set(env, log)
      sendToWindow('operator:activity', env, log[log.length - 1])
      return token !== null
    }
  )
  ipcMain.handle('agents:setDefaultAgent', (_e, agentId: AgentId) => {
    if (!VALID_AGENTS.includes(agentId)) return null
    registry.setDefaultAgent(agentId)
    return registry.list()
  })
  ipcMain.handle(
    'agents:setOverride',
    async (_e, agentId: AgentId, override: AgentOverride): Promise<AgentOverrideResult | null> => {
      if (!VALID_AGENTS.includes(agentId) || typeof override !== 'object' || override === null) {
        return null
      }
      const result = registry.setAgentOverride(agentId, override)
      if (!result.ok) return result
      return { ok: true, agents: await registry.list() }
    }
  )

  ipcMain.handle('theme:get', () => resolveTheme(themesDir, registry.getTheme()))
  ipcMain.handle('theme:list', () => listThemeNames(themesDir))
  ipcMain.handle('theme:set', (_e, name: string) => {
    if (typeof name !== 'string' || name.length === 0)
      return resolveTheme(themesDir, registry.getTheme())
    registry.setTheme(name)
    const resolved = resolveTheme(themesDir, name)
    sendToWindow('theme:changed', resolved)
    return resolved
  })
  ipcMain.on('theme:openFolder', () => void shell.openPath(themesDir))

  createWindow()
})

app.on('before-quit', () => {
  // Stop pty streams before windows die — their late output must never
  // reach a destroyed window.
  managerRef?.disposeAll()
})

app.on('window-all-closed', () => {
  app.quit()
})
