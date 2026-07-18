import type {
  ActivityEntry,
  AddPaneRequest,
  AgentId,
  AgentInfo,
  AgentOverride,
  AgentOverrideResult,
  AgentPathTypedResult,
  GuardPacksResult,
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
import type {
  ClearSecretResult,
  IntegrationId,
  IntegrationView,
  ResolvedIntegrationDescriptor,
  SetEnabledResult,
  SetFieldResult,
  SetSecretResult
} from './integrations'
import type { FlowGraph, FlowSummary } from './flows'
import type { FlowTemplate } from './flow-templates'

export interface LocalflowApi {
  /**
   * Start a session for an agent. `cwd` is honored whenever it's a
   * non-empty absolute (or `~`-prefixed) path — Landing always supplies one
   * (a default, or the user's typed/picked choice), so the native folder
   * picker only opens as a fallback when `cwd` is absent/invalid.
   * `customCommand` is required when agentId is 'custom'. `environment`
   * defaults to 1.
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
  /**
   * A human-readable notice if `sessions.json` existed at startup but
   * couldn't be read/parsed (the corrupt file is backed up and localflow
   * started with an empty saved layout instead). Null on a normal start —
   * including a genuine first run with no saved file yet.
   */
  getPersistenceNotice(): Promise<string | null>
  /**
   * Pushed whenever a later save of the session/group layout fails (e.g.
   * disk full, permission revoked) — mirrors `onThemeChanged`'s push shape.
   * The layout keeps working in memory; this only warns that the on-disk
   * copy is stale until the write starts succeeding again.
   */
  onPersistenceNotice(cb: (message: string) => void): () => void
  /** Last few cleaned output lines of a session — the approve control's peek. */
  peekSession(id: string, maxLines?: number): Promise<string[]>
  /** The pane's full rendered screen — replayed into a fresh xterm on
   *  view-return so the pane isn't blank until the next keystroke. */
  snapshotSession(id: string): Promise<string[]>
  listAgents(): Promise<AgentInfo[]>
  /** Opens a file picker to locate the agent binary; returns the updated list. */
  setAgentPath(agentId: AgentId): Promise<AgentInfo[] | null>
  /**
   * Sets an agent binary's path from typed/pasted text instead of the
   * picker (only surfaced in the UI when allowTypedPaths is on). Validated
   * as a non-empty absolute (or `~`-prefixed) path; `{ok:false, reason}`
   * when main's authoritative `expandTypedPath` rejects a value the
   * renderer's looser pre-check accepted (e.g. `~otheruser/proj`), so the
   * caller can surface why instead of silently doing nothing. Null only for
   * a malformed call (unknown/'custom' agentId, non-string path) — a caller
   * bug, not a user-facing rejection.
   */
  setAgentPathTyped(agentId: AgentId, path: string): Promise<AgentPathTypedResult | null>
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
  /**
   * Persists the enabled opt-in pack ids; applies to newly-launched panes.
   * Security-relevant setting — a disk-write failure is reported (`ok:
   * false`, with `reason`) rather than silently discarded, so the caller can
   * roll back an optimistic UI update and warn the user protection may not
   * be active.
   */
  setGuardPacks(packs: string[]): Promise<GuardPacksResult>
  /** Whether typed-path text inputs are shown alongside Finder pickers. */
  getAllowTypedPaths(): Promise<boolean>
  /** Persists the typed-paths toggle; applies to Settings and Landing immediately. */
  setAllowTypedPaths(allow: boolean): void
  /** Sensible default new-session cwd: the most recent terminal session's cwd, else home. */
  getDefaultCwd(): Promise<string>
  /** Opens the same folder picker session:create falls back to; null if canceled. */
  chooseFolder(): Promise<string | null>
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
  /**
   * Integrations Hub views: descriptor metadata + enabled + per-field presence
   * + live status, for all three integrations. Carries `hasValue` booleans for
   * secret fields and non-secret `value`s from config.json — NEVER a secret
   * value.
   */
  listIntegrations(): Promise<IntegrationView[]>
  /** Persists an integration's enabled flag to config.json (optimistic-with-rollback). */
  setIntegrationEnabled(id: IntegrationId, enabled: boolean): Promise<SetEnabledResult>
  /** Writes one NON-secret config field; rejects a `secret:true` key (that must use setIntegrationSecret). */
  setIntegrationField(id: IntegrationId, key: string, value: string): Promise<SetFieldResult>
  /**
   * Stores one secret field in the keychain (value INBOUND only; the response
   * echoes status, never the value). Rejects a non-secret key.
   */
  setIntegrationSecret(id: IntegrationId, key: string, value: string): Promise<SetSecretResult>
  /** Clears one secret field (or every field for the id when key is omitted). */
  clearIntegrationSecret(id: IntegrationId, key?: string): Promise<ClearSecretResult>
  /** Browser panes report their guest webContents id so the operator API can drive them. */
  registerBrowser(handle: string, webContentsId: number): void
  /**
   * The integration registry that feeds the Flow Canvas palette + config panel.
   * `status()` is resolved to a plain value at fetch time (a method can't cross
   * the IPC boundary). Backed by the real Integrations Hub registry (#1) — the
   * canvas reads only this resolved-descriptor seam.
   */
  listIntegrationDescriptors(): Promise<ResolvedIntegrationDescriptor[]>
  /**
   * The built-in flow templates (config-as-code, read-only) that seed the
   * "New from template" picker. Carries only integration refs + non-secret
   * node config — never a credential. Mirrors `listTemplates`.
   */
  listFlowTemplates(): Promise<FlowTemplate[]>
  /** All saved flows as lightweight summaries (Flow Canvas list view). */
  listFlows(): Promise<FlowSummary[]>
  /** Full flow graph by id; null if unknown/unreadable/corrupt. */
  getFlow(id: string): Promise<FlowGraph | null>
  /** Persists a flow (atomic). ok:false carries a human error (disk full, malformed graph, …). */
  saveFlow(
    graph: FlowGraph
  ): Promise<{ ok: true; summary: FlowSummary } | { ok: false; error: string }>
  /** Removes a saved flow. */
  deleteFlow(id: string): Promise<void>
  /** Hands the saved graph to the Flow Engine (#2 / stub). Returns a run id or a legible error. */
  runFlow(id: string): Promise<{ ok: true; runId: string } | { ok: false; error: string }>
  /**
   * Pushed when a later flow save fails (mirrors onPersistenceNotice) — the
   * editor keeps working in memory; this warns the on-disk copy is stale.
   */
  onFlowPersistenceNotice(cb: (message: string) => void): () => void
  /** Dropped on unmount/exit; a closed pane then resolves to 404 over the control API. */
  unregisterBrowser(handle: string): void
}
