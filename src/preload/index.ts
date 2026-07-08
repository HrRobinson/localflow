import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { LocalflowApi } from '../shared/api'
import type { AgentId, SessionStatus } from '../shared/types'
import type { KeyAction } from '../shared/keybindings'

const api: LocalflowApi = {
  createSession: (agentId: AgentId, cwd?: string, customCommand?: string, environment?: number) =>
    ipcRenderer.invoke('session:create', agentId, cwd, customCommand, environment),
  restartSession: (id: string, fresh?: boolean) => ipcRenderer.invoke('session:restart', id, fresh),
  closeTerminal: (id: string) => ipcRenderer.invoke('session:closeTerminal', id),
  deleteSession: (id: string) => ipcRenderer.invoke('session:delete', id),
  renameSession: (id: string, name: string) => ipcRenderer.invoke('session:rename', id, name),
  setEnvironment: (id: string, environment: number) =>
    ipcRenderer.invoke('session:setEnvironment', id, environment),
  createBrowserSession: (url: string, environment?: number) =>
    ipcRenderer.invoke('session:createBrowser', url, environment),
  setSessionUrl: (id: string, url: string) => ipcRenderer.invoke('session:setUrl', id, url),
  openExternal: (url: string) => ipcRenderer.send('shell:openExternal', url),
  listSessions: () => ipcRenderer.invoke('session:list'),
  peekSession: (id: string, maxLines?: number) => ipcRenderer.invoke('session:peek', id, maxLines),
  listAgents: () => ipcRenderer.invoke('agents:list'),
  setAgentPath: (agentId: AgentId) => ipcRenderer.invoke('agents:setPath', agentId),
  getLastAgent: () => ipcRenderer.invoke('agents:getLastAgent'),
  write: (id: string, data: string) => ipcRenderer.send('session:write', id, data),
  resize: (id: string, cols: number, rows: number) =>
    ipcRenderer.send('session:resize', id, cols, rows),
  onData: (cb) => {
    const listener = (_e: IpcRendererEvent, id: string, data: string): void => cb(id, data)
    ipcRenderer.on('session:data', listener)
    return () => ipcRenderer.removeListener('session:data', listener)
  },
  onStatus: (cb) => {
    const listener = (_e: IpcRendererEvent, id: string, status: SessionStatus): void =>
      cb(id, status)
    ipcRenderer.on('session:status', listener)
    return () => ipcRenderer.removeListener('session:status', listener)
  },
  getKeybindings: () => ipcRenderer.invoke('keybindings:get'),
  onKeyAction: (cb) => {
    const listener = (_e: IpcRendererEvent, action: KeyAction): void => cb(action)
    ipcRenderer.on('keybinding:action', listener)
    return () => ipcRenderer.removeListener('keybinding:action', listener)
  },
  getEnvironmentNames: () => ipcRenderer.invoke('environments:getNames'),
  gitStatus: (id: string) => ipcRenderer.invoke('git:status', id),
  gitDiff: (id: string, path: string, staged: boolean) =>
    ipcRenderer.invoke('git:diff', id, path, staged),
  getCapabilities: () => ipcRenderer.invoke('git:capabilities'),
  openLazygit: (id: string) => ipcRenderer.invoke('git:openLazygit', id),
  openEditor: (id: string) => ipcRenderer.invoke('git:openEditor', id)
}

contextBridge.exposeInMainWorld('localflow', api)
