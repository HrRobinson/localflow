import type {
  ActivityEntry,
  AgentId,
  AgentInfo,
  AgentOverride,
  AgentOverrideResult,
  LastAgent,
  SessionInfo,
  SessionStatus
} from './types'
import type { BindingChangeResult, KeyAction } from './keybindings'
import type { Theme } from './theme'
import type { GitStatus, DiffResult, Capabilities } from './git'

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
  /** Creates a browser pane on the given environment. Null for invalid URLs. */
  createBrowserSession(url: string, environment?: number): Promise<SessionInfo | null>
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
}
