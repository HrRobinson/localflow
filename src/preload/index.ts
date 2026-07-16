import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { LocalflowApi } from '../shared/api'
import type {
  ActivityEntry,
  AddPaneRequest,
  AgentId,
  AgentOverride,
  SessionStatus
} from '../shared/types'
import type { ActivityEntry as OperatorActivityEntry, CaptureKind } from '../shared/operator'
import type { KeyAction } from '../shared/keybindings'
import type { Theme } from '../shared/theme'
import type { ConsoleEvent, ConsolePrefs } from '../shared/console'
import type { IntegrationId } from '../shared/integrations'

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
  getPersistenceNotice: () => ipcRenderer.invoke('persistence:getNotice'),
  onPersistenceNotice: (cb) => {
    const listener = (_e: IpcRendererEvent, message: string): void => cb(message)
    ipcRenderer.on('persistence:notice', listener)
    return () => ipcRenderer.removeListener('persistence:notice', listener)
  },
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
  registerWatchpoint: (
    environment: number,
    workflow: string,
    step: string,
    capture: CaptureKind[]
  ) => ipcRenderer.invoke('operator:registerWatchpoint', environment, workflow, step, capture),
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
  listConsole: () => ipcRenderer.invoke('console:list'),
  readScreenshot: (path: string) => ipcRenderer.invoke('console:readScreenshot', path),
  onConsoleEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, event: ConsoleEvent | ConsoleEvent[]): void => cb(event)
    ipcRenderer.on('console:event', listener)
    return () => ipcRenderer.removeListener('console:event', listener)
  },
  getConsolePrefs: () => ipcRenderer.invoke('console:getPrefs'),
  setConsolePrefs: (prefs: ConsolePrefs) => ipcRenderer.send('console:setPrefs', prefs),
  getGuardPacks: () => ipcRenderer.invoke('guard:getPacks'),
  setGuardPacks: (packs: string[]) => ipcRenderer.invoke('guard:setPacks', packs),
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
  unregisterBrowser: (handle: string) => ipcRenderer.send('browser:unregister', handle),
  listIntegrations: () => ipcRenderer.invoke('integrations:list'),
  setIntegrationEnabled: (id: IntegrationId, enabled: boolean) =>
    ipcRenderer.invoke('integrations:setEnabled', id, enabled),
  setIntegrationField: (id: IntegrationId, key: string, value: string) =>
    ipcRenderer.invoke('integrations:setField', id, key, value),
  setIntegrationSecret: (id: IntegrationId, key: string, value: string) =>
    ipcRenderer.invoke('integrations:setSecret', id, key, value),
  clearIntegrationSecret: (id: IntegrationId, key?: string) =>
    ipcRenderer.invoke('integrations:clearSecret', id, key)
}

contextBridge.exposeInMainWorld('localflow', api)
