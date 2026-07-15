import type {
  ActivityEntry,
  AddPaneRequest,
  AgentId,
  AgentInfo,
  AgentOverride,
  AgentOverrideResult,
  LastAgent,
  SessionGroup,
  SessionInfo,
  SessionStatus
} from './types'
import type { SessionTemplate } from './templates'
import type { BindingChangeResult, KeyAction } from './keybindings'
import type { Theme } from './theme'
import type { GitStatus, DiffResult, Capabilities } from './git'
import type {
  CaptureKind,
  GrantInfo,
  OperatorStatus,
  ActivityEntry as OperatorActivityEntry,
  Capture,
  Watchpoint
} from './operator'
import type { ConsoleEvent, ConsolePrefs } from './console'

export interface LocalflowApi {
  /**
   * Start a session for an agent. The `cwd` parameter is honored only under
   * LOCALFLOW_E2E=1 (test harness); production always opens the folder
   * picker. `customCommand` is required when agentId is 'custom'.
   * `environment` defaults to 1.
   */
  createSession(
    agentId: AgentId,
    cwd?: string,
    customCommand?: string,
    environment?: number
  ): Promise<SessionInfo | null>
  /** Relaunch a dead session; `fresh` starts a new conversation instead of resuming. */
  restartSession(id: string, fresh?: boolean): Promise<SessionInfo>
  /** Ends the pty; the session stays listed as exited, reopenable via resume/fresh. */
  closeTerminal(id: string): Promise<void>
  /** Removes the session entirely — separate, explicit, irreversible action. */
  deleteSession(id: string): Promise<void>
  /** Renames a session; empty/whitespace name is a no-op. Returns the updated info, or null if the id is unknown. */
  renameSession(id: string, name: string): Promise<SessionInfo | null>
  /** Moves a session to environment 1-9 (clamped). Null if the id is unknown. */
  setEnvironment(id: string, environment: number): Promise<SessionInfo | null>
  /** Creates a group ("session") on the given environment. Null if name is empty/whitespace-only. */
  createGroup(name: string, environment: number): Promise<SessionGroup | null>
  /** Renames a group; empty/whitespace name is a no-op. Null if the id is unknown. */
  renameGroup(id: string, name: string): Promise<SessionGroup | null>
  /** Sets or clears (`groupId: null`) a pane's group. Null if the pane or group is unknown, or their environments differ. */
  assignToGroup(paneId: string, groupId: string | null): Promise<SessionInfo | null>
  /** All groups. */
  listGroups(): Promise<SessionGroup[]>
  /**
   * Adds a companion pane next to `sourcePaneId`: reuses its group, or wraps
   * a solo source into a fresh group named after it. cwd/environment are
   * derived from the source pane's own record, never from this call. Null
   * for an unknown source or malformed request.
   */
  addPane(sourcePaneId: string, req: AddPaneRequest): Promise<SessionInfo | null>
  /** Creates a browser pane on the given environment. Null for invalid URLs. */
  createBrowserSession(url: string, environment?: number): Promise<SessionInfo | null>
  /** Session templates from config.json's `sessionTemplates` key (read fresh each call). */
  listTemplates(): Promise<SessionTemplate[]>
  /**
   * Creates a new group ("session") from a named template: one pane per
   * template entry, skipping any whose agent binary isn't found. `cwd` is
   * honored only under LOCALFLOW_E2E=1 — production always opens the folder
   * picker (same posture as createSession). Null for an unknown template, a
   * canceled picker, or a template where every pane's agent is missing.
   */
  createTemplate(
    name: string,
    cwd: string | undefined,
    environment: number
  ): Promise<SessionInfo[] | null>
  /** Persists a browser pane's current URL (follows navigation). */
  setSessionUrl(id: string, url: string): Promise<SessionInfo | null>
  /** Opens an http(s) URL in the system browser. Non-http(s) is dropped in main. */
  openExternal(url: string): void
  listSessions(): Promise<SessionInfo[]>
  /** Last few cleaned output lines of a session — the approve control's peek. */
  peekSession(id: string, maxLines?: number): Promise<string[]>
  listAgents(): Promise<AgentInfo[]>
  /** Opens a file picker to locate the agent binary; returns the updated list. */
  setAgentPath(agentId: AgentId): Promise<AgentInfo[] | null>
  /** Sets the launcher's default agent; returns the refreshed list. */
  setDefaultAgent(agentId: AgentId): Promise<AgentInfo[] | null>
  /**
   * Sets per-agent extra args + env overrides. Ok carries the refreshed
   * list; env keys owned by localflow's hook injection are rejected with
   * the offending names (writing them would kill the status feed). Null
   * only for a malformed call (unknown agent / non-object override).
   */
  setAgentOverride(agentId: AgentId, override: AgentOverride): Promise<AgentOverrideResult | null>
  getLastAgent(): Promise<LastAgent | null>
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  onData(cb: (id: string, data: string) => void): () => void
  onStatus(cb: (id: string, status: SessionStatus) => void): () => void
  /** The full activity ring for a session (oldest first). */
  getActivity(id: string): Promise<ActivityEntry[]>
  /** New activity entries pushed as they happen (mirrors onStatus). */
  onActivity(cb: (id: string, entry: ActivityEntry) => void): () => void
  getKeybindings(): Promise<Record<KeyAction, string>>
  /**
   * Rebinds one action live. Rejected with a typed reason when the binding
   * string is unparseable or the combo is held by another action; a re-set
   * of the current value succeeds with `changed: false` (nothing written).
   */
  setKeybinding(action: KeyAction, binding: string): Promise<BindingChangeResult>
  /** Restores one action to its default binding. Returns the full map. */
  resetKeybinding(action: KeyAction): Promise<Record<KeyAction, string>>
  /** Restores every binding to defaults. Returns the full map. */
  resetAllKeybindings(): Promise<Record<KeyAction, string>>
  /** Full binding map pushed from main after any set/reset (live rebinding). */
  onKeybindingsChanged(cb: (bindings: Record<KeyAction, string>) => void): () => void
  /** Bound combos pressed while a webview has focus, forwarded from main. */
  onKeyAction(cb: (action: KeyAction) => void): () => void
  /** Optional hand-configured environment names from config.json ("3" -> "backend"). */
  getEnvironmentNames(): Promise<Record<string, string>>
  /** Grants (or returns the existing) operator on an environment; mints its bearer token + loopback endpoint. */
  grantOperator(environment: number): Promise<GrantInfo>
  /** Revokes the operator on an environment; its token stops resolving immediately. */
  revokeOperator(environment: number): Promise<void>
  /** Grant + connection state + the rolling action log for an environment. */
  operatorStatus(environment: number): Promise<OperatorStatus>
  /** Watchpoint captures stored for an environment, oldest first. */
  listCaptures(environment: number): Promise<Capture[]>
  /** Registered watchpoints for an environment. */
  listWatchpoints(environment: number): Promise<Watchpoint[]>
  /** Registers a watchpoint on an environment. Null when a field is malformed. */
  registerWatchpoint(
    environment: number,
    workflow: string,
    step: string,
    capture: CaptureKind[]
  ): Promise<Watchpoint | null>
  /** Resolve a halted capture (approve = continue, false = stop); returns whether a token was cleared. */
  resumeCapture(environment: number, captureId: string, approve: boolean): Promise<boolean>
  /** Live control-API action-log entries, per environment. */
  onOperatorActivity(cb: (environment: number, entry: OperatorActivityEntry) => void): () => void
  /** Snapshot of the console event ring (bottom console drawer). */
  listConsole(): Promise<ConsoleEvent[]>
  /** Reads a capture screenshot as a data URI. Null for a path outside the capture store or an unreadable file. */
  readScreenshot(path: string): Promise<string | null>
  /** New console events pushed as they happen (singular from emit, array from emitBatch). */
  onConsoleEvent(cb: (event: ConsoleEvent | ConsoleEvent[]) => void): () => void
  /** Persisted drawer prefs: height, open state, last filter. */
  getConsolePrefs(): Promise<ConsolePrefs>
  /** Persists drawer prefs (fire-and-forget; debounced by the caller). */
  setConsolePrefs(prefs: ConsolePrefs): void
  /** Enabled opt-in lfguard pack ids (core.filesystem/core.git are always on, not included). */
  getGuardPacks(): Promise<string[]>
  /** Persists the enabled opt-in pack ids; applies to newly-launched panes. */
  setGuardPacks(packs: string[]): void
  /** Working-tree status for a session's repo. `repo:false` when the cwd isn't a git repo (or the session has none). */
  gitStatus(id: string): Promise<GitStatus>
  /** Diff text for one path at one layer. Untracked files come back as full additions; size-capped. */
  gitDiff(id: string, path: string, staged: boolean): Promise<DiffResult>
  /** lazygit/editor availability + the configured editor command, probed once and cached in main. */
  getCapabilities(): Promise<Capabilities>
  /** Spawns a custom `lazygit` terminal session in the session's own cwd + environment. Null when it has no cwd or lazygit is unresolved. */
  openLazygit(id: string): Promise<SessionInfo | null>
  /** Opens the session's cwd in the configured editor (external, detached). false when unavailable. */
  openEditor(id: string): Promise<boolean>
  /** Current resolved theme; carries an error notice when the file was bad. */
  getTheme(): Promise<{ name: string; theme: Theme; error?: string }>
  /** Available theme names (userData/themes/*.json). */
  listThemes(): Promise<string[]>
  /** Selects a theme; persists and returns the resolved theme (or default). */
  setTheme(name: string): Promise<{ name: string; theme: Theme; error?: string }>
  /** Opens the themes folder in the OS file manager (community sharing). */
  openThemesFolder(): void
  /** Theme pushed from main after a set — the live-apply channel. */
  onThemeChanged(cb: (payload: { name: string; theme: Theme; error?: string }) => void): () => void
  /** Browser panes report their guest webContents id so the operator API can drive them. */
  registerBrowser(handle: string, webContentsId: number): void
  /** Dropped on unmount/exit; a closed pane then resolves to 404 over the control API. */
  unregisterBrowser(handle: string): void
}
