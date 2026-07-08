import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { LocalflowApi } from '../shared/api'
import type { AgentId, SessionStatus } from '../shared/types'

const api: LocalflowApi = {
  createSession: (agentId: AgentId, cwd?: string, customCommand?: string, workspace?: number) =>
    ipcRenderer.invoke('session:create', agentId, cwd, customCommand, workspace),
  restartSession: (id: string, fresh?: boolean) => ipcRenderer.invoke('session:restart', id, fresh),
  closeTerminal: (id: string) => ipcRenderer.invoke('session:closeTerminal', id),
  deleteSession: (id: string) => ipcRenderer.invoke('session:delete', id),
  renameSession: (id: string, name: string) => ipcRenderer.invoke('session:rename', id, name),
  setWorkspace: (id: string, workspace: number) =>
    ipcRenderer.invoke('session:setWorkspace', id, workspace),
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
  getKeybindings: () => ipcRenderer.invoke('keybindings:get')
}

contextBridge.exposeInMainWorld('localflow', api)
