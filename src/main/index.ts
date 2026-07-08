import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron'
import { join } from 'node:path'
import { existsSync, writeFileSync } from 'node:fs'
import type { AgentId } from '../shared/types'
import { startHookServer } from './hook-server'
import { SessionManager, type SpawnSpec } from './session-manager'
import { loadSavedSessions, saveSessions } from './persistence'
import { AgentRegistry } from './agent-registry'
import { loadOrCreateKeybindings } from './keybindings-file'

if (process.env['LOCALFLOW_USER_DATA']) {
  app.setPath('userData', process.env['LOCALFLOW_USER_DATA'])
}

const VALID_AGENTS: AgentId[] = ['claude', 'codex', 'gemini', 'custom']

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
      sandbox: false
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
  const keybindings = loadOrCreateKeybindings(join(userData, 'keybindings.json'))

  const registry = new AgentRegistry(
    join(userData, 'config.json'),
    undefined,
    process.env['LOCALFLOW_CLAUDE_BIN']
  )

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
    hookAdapter: registry.hookAdapter(agentId)
  })

  // A destroyed BrowserWindow still non-null: guard every send, because pty
  // output keeps streaming while the app tears down (crash: "Object has been
  // destroyed" dialogs during quit/reload otherwise).
  const sendToWindow = (channel: string, ...args: unknown[]): void => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
  }
  manager.onData((id, data) => sendToWindow('session:data', id, data))
  manager.onStatus((id, status) => sendToWindow('session:status', id, status))
  manager.onSessionsChanged(() =>
    saveSessions(
      sessionsFile,
      manager
        .list()
        .map(({ id, cwd, agentId, command, name }) => ({ id, cwd, agentId, command, name }))
    )
  )

  for (const saved of loadSavedSessions(sessionsFile)) {
    const agentId = VALID_AGENTS.includes(saved.agentId as AgentId)
      ? (saved.agentId as AgentId)
      : 'claude'
    // A saved custom session keeps its stored command verbatim.
    const spec = agentId === 'custom' ? specFor(agentId, saved.command ?? '') : specFor(agentId)
    manager.restore(saved.id, saved.cwd, spec, saved.name)
  }

  ipcMain.handle(
    'session:create',
    async (_e, agentId: AgentId, cwd?: string, customCommand?: string) => {
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
      const created = manager.create(dir, specFor(agentId, customCommand?.trim()))
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
  ipcMain.handle('session:list', () => manager.list())
  ipcMain.handle('session:peek', (_e, id: string, maxLines?: number) =>
    // Clamp at the boundary: the renderer is not trusted with the range.
    manager.peek(id, Math.min(Math.max(Number(maxLines) || 5, 1), 20))
  )
  ipcMain.on('session:write', (_e, id: string, data: string) => manager.write(id, data))
  ipcMain.on('session:resize', (_e, id: string, cols: number, rows: number) =>
    manager.resize(id, cols, rows)
  )

  ipcMain.handle('keybindings:get', () => keybindings)

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
