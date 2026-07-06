import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { startHookServer } from './hook-server'
import { SessionManager } from './session-manager'
import { loadSavedSessions, saveSessions } from './persistence'

if (process.env['LOCALFLOW_USER_DATA']) {
  app.setPath('userData', process.env['LOCALFLOW_USER_DATA'])
}

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

  const endpoint = await startHookServer((e) => manager.applyHookEvent(e))
  if (process.env['LOCALFLOW_E2E'] === '1') {
    writeFileSync(
      join(userData, 'endpoint.json'),
      JSON.stringify({ port: endpoint.port, token: endpoint.token })
    )
  }

  const manager = new SessionManager({
    settingsDir: userData,
    port: endpoint.port,
    token: endpoint.token,
    claudeBin: process.env['LOCALFLOW_CLAUDE_BIN'] ?? 'claude'
  })

  manager.onData((id, data) => win?.webContents.send('session:data', id, data))
  manager.onStatus((id, status) => win?.webContents.send('session:status', id, status))
  manager.onSessionsChanged(() =>
    saveSessions(
      sessionsFile,
      manager.list().map(({ id, cwd }) => ({ id, cwd }))
    )
  )

  for (const saved of loadSavedSessions(sessionsFile)) {
    manager.restore(saved.id, saved.cwd)
  }

  ipcMain.handle('session:create', async (_e, cwd?: string) => {
    let dir = cwd
    if (!dir) {
      const result = await dialog.showOpenDialog(win!, {
        properties: ['openDirectory', 'createDirectory'],
        title: 'Choose a project folder for the new Claude session'
      })
      if (result.canceled || result.filePaths.length === 0) return null
      dir = result.filePaths[0]
    }
    return manager.create(dir)
  })
  ipcMain.handle('session:restart', (_e, id: string) => manager.restart(id))
  ipcMain.handle('session:kill', (_e, id: string) => manager.kill(id))
  ipcMain.handle('session:list', () => manager.list())
  ipcMain.on('session:write', (_e, id: string, data: string) => manager.write(id, data))
  ipcMain.on('session:resize', (_e, id: string, cols: number, rows: number) =>
    manager.resize(id, cols, rows)
  )

  createWindow()
})

app.on('window-all-closed', () => {
  app.quit()
})
