import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { LocalflowApi } from '../shared/api'
import type {
  ActivityEntry,
  AddPaneRequest,
  AgentId,
  AgentOverride,
  SessionStatus
} from '../shared/types'
import type { ActivityEntry as OperatorActivityEntry } from '../shared/operator'
import type { KeyAction } from '../shared/keybindings'
import type { Theme } from '../shared/theme'

const api: LocalflowApi = {
  createSession: (agentId: AgentId, cwd?: string, customCommand?: string, environment?: number) =>
    ipcRenderer.invoke('session:create', agentId, cwd, customCommand, environment),
  restartSession: (id: string, fresh?: boolean) => ipcRenderer.invoke('session:restart', id, fresh),
  closeTerminal: (id: string) => ipcRenderer.invoke('session:closeTerminal', id),
  deleteSession: (id: string) => ipcRenderer.invoke('session:delete', id),
  renameSession: (id: string, name: string) => ipcRenderer.invoke('session:rename', id, name),
  setEnvironment: (id: string, environment: number) =>
    ipcRenderer.invoke('session:setEnvironment', id, environment),
  createGroup: (name: string, environment: number) =>
    ipcRenderer.invoke('group:create', name, environment),
  renameGroup: (id: string, name: string) => ipcRenderer.invoke('group:rename', id, name),
  assignToGroup: (paneId: string, groupId: string | null) =>
    ipcRenderer.invoke('group:assign', paneId, groupId),
  listGroups: () => ipcRenderer.invoke('group:list'),
  addPane: (sourcePaneId: string, req: AddPaneRequest) =>
    ipcRenderer.invoke('group:addPane', sourcePaneId, req),
  createBrowserSession: (url: string, environment?: number) =>
    ipcRenderer.invoke('session:createBrowser', url, environment),
  listTemplates: () => ipcRenderer.invoke('templates:list'),
  createTemplate: (name: string, cwd: string | undefined, environment: number) =>
    ipcRenderer.invoke('templates:create', name, cwd, environment),
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
  getActivity: (id: string) => ipcRenderer.invoke('activity:get', id),
  onActivity: (cb) => {
    const listener = (_e: IpcRendererEvent, id: string, entry: ActivityEntry): void => cb(id, entry)
    ipcRenderer.on('activity:event', listener)
    return () => ipcRenderer.removeListener('activity:event', listener)
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
  getEnvironmentNames: () => ipcRenderer.invoke('environments:getNames'),
  grantOperator: (environment: number) => ipcRenderer.invoke('operator:grant', environment),
  revokeOperator: (environment: number) => ipcRenderer.invoke('operator:revoke', environment),
  operatorStatus: (environment: number) => ipcRenderer.invoke('operator:status', environment),
  listCaptures: (environment: number) => ipcRenderer.invoke('operator:captures', environment),
  listWatchpoints: (environment: number) => ipcRenderer.invoke('operator:watchpoints', environment),
  resumeCapture: (environment: number, captureId: string, approve: boolean) =>
    ipcRenderer.invoke('operator:resume', environment, captureId, approve),
  onOperatorActivity: (cb) => {
    const listener = (
      _e: IpcRendererEvent,
      environment: number,
      entry: OperatorActivityEntry
    ): void => cb(environment, entry)
    ipcRenderer.on('operator:activity', listener)
    return () => ipcRenderer.removeListener('operator:activity', listener)
  },
  gitStatus: (id: string) => ipcRenderer.invoke('git:status', id),
  gitDiff: (id: string, path: string, staged: boolean) =>
    ipcRenderer.invoke('git:diff', id, path, staged),
  getCapabilities: () => ipcRenderer.invoke('git:capabilities'),
  openLazygit: (id: string) => ipcRenderer.invoke('git:openLazygit', id),
  openEditor: (id: string) => ipcRenderer.invoke('git:openEditor', id),
  getTheme: () => ipcRenderer.invoke('theme:get'),
  listThemes: () => ipcRenderer.invoke('theme:list'),
  setTheme: (name: string) => ipcRenderer.invoke('theme:set', name),
  openThemesFolder: () => ipcRenderer.send('theme:openFolder'),
  onThemeChanged: (cb) => {
    const listener = (
      _e: IpcRendererEvent,
      payload: { name: string; theme: Theme; error?: string }
    ): void => cb(payload)
    ipcRenderer.on('theme:changed', listener)
    return () => ipcRenderer.removeListener('theme:changed', listener)
  },
  registerBrowser: (handle: string, webContentsId: number) =>
    ipcRenderer.send('browser:register', handle, webContentsId),
  unregisterBrowser: (handle: string) => ipcRenderer.send('browser:unregister', handle)
}

contextBridge.exposeInMainWorld('localflow', api)
