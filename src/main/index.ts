import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import type { AgentId } from '../shared/types'
import { startHookServer } from './hook-server'
import { SessionManager, type SpawnSpec } from './session-manager'
import { loadSavedSessions, saveSessions } from './persistence'
import { AgentRegistry } from './agent-registry'

if (process.env['LOCALFLOW_USER_DATA']) {
  app.setPath('userData', process.env['LOCALFLOW_USER_DATA'])
}

const VALID_AGENTS: AgentId[] = ['claude', 'codex', 'gemini', 'custom']

let win: BrowserWindow | null = null

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

app.whenReady().then(async () => {
  const userData = app.getPath('userData')
  const sessionsFile = join(userData, 'sessions.json')

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

  const specFor = (agentId: AgentId, customCommand?: string): SpawnSpec => ({
    agentId,
    command: registry.commandFor(agentId, customCommand),
    resumeArgs: registry.argsFor(agentId, true),
    useHooks: registry.useHooks(agentId)
  })

  manager.onData((id, data) => win?.webContents.send('session:data', id, data))
  manager.onStatus((id, status) => win?.webContents.send('session:status', id, status))
  manager.onSessionsChanged(() =>
    saveSessions(
      sessionsFile,
      manager.list().map(({ id, cwd, agentId, command }) => ({ id, cwd, agentId, command }))
    )
  )

  for (const saved of loadSavedSessions(sessionsFile)) {
    const agentId = VALID_AGENTS.includes(saved.agentId as AgentId)
      ? (saved.agentId as AgentId)
      : 'claude'
    // A saved custom session keeps its stored command verbatim.
    const spec = agentId === 'custom' ? specFor(agentId, saved.command ?? '') : specFor(agentId)
    manager.restore(saved.id, saved.cwd, spec)
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
      return manager.create(dir, specFor(agentId, customCommand?.trim()))
    }
  )
  ipcMain.handle('session:restart', (_e, id: string, fresh?: boolean) =>
    manager.restart(id, fresh === true)
  )
  ipcMain.handle('session:kill', (_e, id: string) => manager.kill(id))
  ipcMain.handle('session:list', () => manager.list())
  ipcMain.on('session:write', (_e, id: string, data: string) => manager.write(id, data))
  ipcMain.on('session:resize', (_e, id: string, cols: number, rows: number) =>
    manager.resize(id, cols, rows)
  )

  ipcMain.handle('agents:list', () => registry.list())
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

app.on('window-all-closed', () => {
  app.quit()
})
