import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { LocalflowApi } from '../shared/api'
import type { AgentId, AgentOverride, SessionStatus } from '../shared/types'
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
  setDefaultAgent: (agentId: AgentId) => ipcRenderer.invoke('agents:setDefaultAgent', agentId),
  setAgentOverride: (agentId: AgentId, override: AgentOverride) =>
    ipcRenderer.invoke('agents:setOverride', agentId, override),
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
  setKeybinding: (action: KeyAction, binding: string) =>
    ipcRenderer.invoke('keybindings:set', action, binding),
  resetKeybinding: (action: KeyAction) => ipcRenderer.invoke('keybindings:reset', action),
  resetAllKeybindings: () => ipcRenderer.invoke('keybindings:resetAll'),
  onKeybindingsChanged: (cb) => {
    const listener = (_e: IpcRendererEvent, bindings: Record<KeyAction, string>): void =>
      cb(bindings)
    ipcRenderer.on('keybindings:changed', listener)
    return () => ipcRenderer.removeListener('keybindings:changed', listener)
  },
  onKeyAction: (cb) => {
    const listener = (_e: IpcRendererEvent, action: KeyAction): void => cb(action)
    ipcRenderer.on('keybinding:action', listener)
    return () => ipcRenderer.removeListener('keybinding:action', listener)
  },
  getEnvironmentNames: () => ipcRenderer.invoke('environments:getNames')
}

contextBridge.exposeInMainWorld('localflow', api)
