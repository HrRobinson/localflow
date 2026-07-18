import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, shell } from 'electron'
import { join, basename } from 'node:path'
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import {
  VALID_AGENTS,
  type AgentId,
  type AgentOverride,
  type AgentOverrideResult,
  type AgentPathTypedResult,
  type GuardPacksResult,
  type SessionInfo
} from '../shared/types'
import { clampEnvironment } from '../shared/environment'
import { normalizeHttpUrl, isHttpUrl } from '../shared/urls'
import { expandTypedPath, resolveDefaultCwd } from '../shared/paths'
import { parseSessionTemplates, type SessionTemplate } from '../shared/templates'
import { startHookServer } from './hook-server'
import { SessionManager, type SpawnSpec } from './session-manager'
import { loadSavedState, saveState } from './persistence'
import { PersistenceNoticeRouter } from './persistence-notice'
import { resolveDescriptors } from '../shared/integrations'
import { isFlowGraph, summarize, type FlowGraph, type FlowSummary } from '../shared/flows'
import { loadFlows, saveFlows } from './flow/flow-store'
import { BUILTIN_FLOW_TEMPLATES } from './flow/builtin-templates'
import { loadFlowsConfig } from './flow/flow-config'
import { FlowEngine } from './flow/flow-engine'
import { PaneDriver } from './flow/pane-driver'
import type { ApprovalPort } from './flow/types'
import { AgentRegistry, whichViaLoginShell } from './agent-registry'
import { resolveShellPath } from './resolve-shell-path'
import { resolveGuardBinary } from './guard-binary'
import { makeOperatorGuard } from './operator-guard'
import { ensureThemesSeeded, listThemeNames, resolveTheme } from './theme-store'
import { loadOrCreateKeybindings, writeKeybindings } from './keybindings-file'
import { loadEnvironmentNames } from './environment-names'
import { installWebviewPolicy } from './webview-policy'
import { gitStatus, gitDiff } from './git'
import { describeTool, gateBin } from './tools'
import { editorLaunch, loadEditorCommand } from './editor-config'
import { loadOperatorRevokeOnExit } from './operator-config'
import {
  defaultOpenclawConfig,
  removeSkillEnv,
  writeSkillEnv,
  type SkillEnvResult
} from './openclaw-config'
import { splitCommandLine } from '../shared/args'
import { PaneRegistry } from './pane-registry'
import { addCompanionPane, operatorCreatePane, type AddPaneRequest } from './pane-ops'
import { OperatorGrantStore } from './operator-grant'
import { credentialEnv, OperatorLaunchTracker } from './operator-launch'
import { startControlServer, type ControlDeps, type OperatorPaneRequest } from './control-api'
import { BrowserBridge } from './browser-bridge'
import { WebviewBrowserControl } from './browser-control'
import { CaptureStore } from './capture-store'
import { WatchpointRegistry } from './watchpoints'
import { ConsoleEventBus } from './console-bus'
import { toStatusEvent, toOperatorEvent, toCaptureEvent, toGuardEvent } from '../shared/console'
import type { ConsolePrefs } from '../shared/console'
import { startGuardAuditTail } from './guard-audit-tail'
import { CredentialStore } from './integrations/credential-store'
import { IntegrationRegistry } from './integrations/integration-registry'
import type { IntegrationId } from '../shared/integrations'
import { ShopifyConnector } from './shopify/shopify-connector'
import { ShopifyAdminApi, deferredLiveTransport } from './shopify/shopify-admin'
import { WcApi } from './woocommerce/wc-api'
import { WoocommerceConnector } from './woocommerce/woocommerce-connector'
import {
  PostHogHttpApi,
  deferredLiveTransport as deferredPostHogTransport
} from './posthog/posthog-api'
import { PostHogConnector } from './posthog/posthog-connector'
import { PostHogPoller } from './posthog/posthog-poller'
import { PostHogCursorStore } from './posthog/posthog-cursor-store'
import { GitLabRestApi } from './gitlab/gitlab-api'
import { GitLabConnector } from './gitlab/gitlab-connector'
import { SlackConnector } from './slack/slack-connector'
import { SlackWebApi, deferredLiveTransport as slackDeferredTransport } from './slack/slack-client'
import { SlackApprovalPort } from './slack/slack-approval-port'
import { parseSlackConfig } from './slack/slack-config'
import { loadIntegrationsConfig } from './integrations/integration-config'
import { HttpConnector } from './http/http-connector'
import { HttpClient, FetchHttpTransport } from './http/http-client'
import { HttpTokenStore } from './http/http-token-store'
import { StripeConnector } from './stripe/stripe-connector'
import {
  StripeApiClient,
  deferredLiveTransport as deferredStripeTransport
} from './stripe/stripe-client'
import { GitHubConnector } from './github/github-connector'
import {
  GitHubRestApi,
  deferredLiveTransport as deferredGitHubTransport
} from './github/github-api'
import { PatAuth } from './github/github-auth'
import { startGuardSeenWatch } from './guard-seen-watch'
import type { ActivityEntry, GrantInfo, OperatorStatus } from '../shared/operator'
import type { Capabilities } from '../shared/git'
import {
  DEFAULT_BINDINGS,
  applyBindingChange,
  type BindingChangeResult,
  type KeyAction
} from '../shared/keybindings'

if (process.env['LOCALFLOW_USER_DATA']) {
  app.setPath('userData', process.env['LOCALFLOW_USER_DATA'])
}

/**
 * Reads config.json's `sessionTemplates` fresh on every call (same posture
 * as loadEditorCommand in editor-config.ts) — hand edits apply without a
 * restart. Never throws: a missing/corrupt file or malformed array is [].
 */
function loadSessionTemplates(configFile: string): SessionTemplate[] {
  try {
    const data: unknown = JSON.parse(readFileSync(configFile, 'utf8'))
    const raw =
      typeof data === 'object' && data !== null
        ? (data as { sessionTemplates?: unknown }).sessionTemplates
        : undefined
    return parseSessionTemplates(raw)
  } catch {
    return []
  }
}

let win: BrowserWindow | null = null
let managerRef: SessionManager | null = null

// Buffers persistence save-failure notices raised before the window exists and
// flushes them once it loads (see PersistenceNoticeRouter). Module-level so
// createWindow's did-finish-load handler can flush what the whenReady closure
// reported during the pre-window startup restore.
const persistenceNotices = new PersistenceNoticeRouter((message) => {
  if (win && !win.isDestroyed()) {
    win.webContents.send('persistence:notice', message)
    return true
  }
  return false
})

// Flow-store save-failure notices (mirrors persistenceNotices). Pushed on the
// `flow:notice` channel so the Flow Canvas can warn the on-disk copy is stale.
const flowNotices = new PersistenceNoticeRouter((message) => {
  if (win && !win.isDestroyed()) {
    win.webContents.send('flow:notice', message)
    return true
  }
  return false
})

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'localflow',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Browser panes use the <webview> tag: it participates in DOM layout
      // (grid/enlarge/focus need no special-casing, unlike WebContentsView).
      // Guest pages are locked down in installWebviewPolicy.
      webviewTag: true
    }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // Flush any persistence notice buffered before the window existed (a save
  // failure during the pre-window startup restore) once the renderer is live.
  win.webContents.once('did-finish-load', () => {
    persistenceNotices.flush()
    flowNotices.flush()
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * Electron's default application menu binds cmd+w to Close Window, cmd+h
 * to Hide and cmd+m to Minimize. localflow owns those as in-app pane keys
 * (close-pane, focus-left, enlarge-toggle), so the menu must not carry
 * those accelerators.
 */
function buildAppMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      role: 'appMenu',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        // Not role: 'hide' — Electron treats `accelerator: undefined` on a
        // role item as omitted and applies the role default (Cmd+H), which
        // must stay free for the in-app focus-left key.
        { label: 'Hide localflow', click: () => app.hide() },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    {
      label: 'Window',
      submenu: [
        // Not role: 'minimize' — its role default (Cmd+M) must stay free
        // for the in-app enlarge-toggle key.
        { label: 'Minimize', click: () => BrowserWindow.getFocusedWindow()?.minimize() },
        { role: 'zoom' }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(async () => {
  buildAppMenu()

  // A macOS app launched from Finder/Dock inherits only a minimal PATH (no
  // ~/.local/bin, homebrew, nvm), so a bare agent command like `claude` isn't
  // found and its pty exits instantly — nothing opens or resumes. Resolve the
  // login-shell PATH once here, before any pane can spawn, so every later pty
  // inherits it via process.env. Fail-safe: time-bounded (and the bound is
  // enforced independently of the shell probe itself, so a pipe-holding
  // grandchild can't extend it), never throws, and worst case leaves PATH
  // unchanged; a no-op off macOS and in dev. Awaiting here yields the event
  // loop rather than blocking it, and still completes before window creation.
  process.env['PATH'] = await resolveShellPath()

  // Dev-mode dock icon (packaged builds get it from build/icon.png via
  // electron-builder; in dev Electron shows its default logo otherwise).
  if (!app.isPackaged && process.platform === 'darwin') {
    const devIcon = join(__dirname, '../../assets/icon-512.png')
    if (existsSync(devIcon)) app.dock?.setIcon(devIcon)
  }

  const userData = app.getPath('userData')
  const sessionsFile = join(userData, 'sessions.json')
  let keybindings = loadOrCreateKeybindings(join(userData, 'keybindings.json'))

  const registry = new AgentRegistry(
    join(userData, 'config.json'),
    undefined,
    process.env['LOCALFLOW_CLAUDE_BIN'],
    process.env['LOCALFLOW_OPENCLAW_BIN']
  )

  // Integrations Hub: the CredentialStore (secrets → safeStorage-encrypted
  // sidecar, never config.json) + the registry the flow engine/canvas consume.
  // safeStorage is Electron's real backend; the seam keeps it unit-testable.
  const integrationCreds = new CredentialStore({
    backend: safeStorage,
    file: join(userData, 'integration-secrets.enc')
  })
  const integrationRegistry = new IntegrationRegistry({
    creds: integrationCreds,
    configFile: join(userData, 'config.json'),
    // Config-boundary notices (e.g. a secret hand-edited into config.json) —
    // legible, actionable, and NEVER carrying the secret value itself.
    notify: (message) => console.warn(`integrations: ${message}`)
  })

  // Shopify connector: the FIRST live dispatch behind the registry seam (§4.3).
  // The live GraphQL transport and the webhook tunnel are DEFERRED (foundation
  // slice) — `deferredLiveTransport` fails loudly if an action reaches the wire,
  // so the descriptor, normalizer, and mock-tested dispatch are all in place
  // while real Shopify calls land in a later phase. No webhook server is started
  // (cloud ingress deferred); trigger subscriptions register but stay dormant.
  integrationRegistry.registerConnector(
    'shopify',
    new ShopifyConnector({
      api: new ShopifyAdminApi({ transport: deferredLiveTransport('shopify') })
    })
  )

  // WooCommerce connector: register the LiveConnector into the registry so the
  // flow engine can dispatch its actions/triggers (spec §4.1). The offline
  // foundation ships the connector + its dispatch table + the SSRF/HMAC/normalize
  // core; the LIVE transport and the CredentialStore reveal binding are DEFERRED
  // (spec §11) — until they land, any live call rejects with a legible message
  // rather than silently no-opping. `storeUrl` is a public placeholder so the
  // SSRF guard passes and the deferred-reveal message is what surfaces.
  const deferredWooError = (): never => {
    throw new Error(
      'WooCommerce live dispatch is not wired yet — the offline connector core is in place, ' +
        'but real HTTP + credential access land in a follow-up (spec §11).'
    )
  }
  integrationRegistry.registerConnector(
    'woocommerce',
    new WoocommerceConnector({
      api: new WcApi({
        transport: {
          send: () => Promise.reject(new Error('WooCommerce HTTP transport is deferred.'))
        },
        storeUrl: 'https://woocommerce.deferred.invalid',
        reveal: deferredWooError
      })
    })
  )

  // PostHog connector: the FIRST POLL-primary live connector (spec §7). The
  // offline foundation ships the descriptor + dispatch table + the SSRF/normalize
  // core + the persisted-cursor reconcile poller; the LIVE HTTP transport and the
  // CredentialStore reveal binding are DEFERRED (spec §4.3) — until they land, any
  // live call rejects with a legible message rather than silently no-opping. The
  // poller's cadence timer is not started here (no live transport to poll yet);
  // its cursor sidecar path is reserved so a restart-resume works once wired.
  const deferredPostHogKey = (): never => {
    throw new Error(
      'PostHog live dispatch is not wired yet — the offline connector core (descriptor, ' +
        'normalizer, poller, cursor store) is in place, but real HTTP + credential access land ' +
        'in a follow-up (spec §4.3).'
    )
  }
  const posthogApi = new PostHogHttpApi({
    transport: deferredPostHogTransport(),
    host: 'https://us.posthog.com',
    projectApiKey: 'phc_deferred',
    reveal: deferredPostHogKey
  })
  const posthogPoller = new PostHogPoller({
    api: posthogApi,
    cursors: new PostHogCursorStore({ file: join(userData, 'posthog-cursors.json') }),
    now: () => Date.now(),
    log: (message) => console.warn(`posthog: ${message}`)
  })
  integrationRegistry.registerConnector(
    'posthog',
    new PostHogConnector({ api: posthogApi, poller: posthogPoller })
  )

  // GitLab connector: register the LiveConnector so the flow engine can dispatch
  // its actions/triggers (spec §4.3). The offline foundation ships the connector
  // + its dispatch table + the SSRF/normalize/webhook core; the LIVE HTTP
  // transport, the CredentialStore reveal binding, and the on-LAN webhook bind are
  // DEFERRED — until they land, any live call rejects with a legible message
  // rather than silently no-opping. `baseUrl` is a public placeholder so the SSRF
  // guard passes and the deferred-reveal message is what surfaces. `mergeMR` is
  // still hard-gated by the connector (§9) regardless of wiring state.
  const deferredGitLabError = (): never => {
    throw new Error(
      'GitLab live dispatch is not wired yet — the offline connector core is in place, ' +
        'but real HTTP + credential access + the on-LAN webhook bind land in a follow-up.'
    )
  }
  integrationRegistry.registerConnector(
    'gitlab',
    new GitLabConnector({
      api: new GitLabRestApi({
        transport: {
          send: () => Promise.reject(new Error('GitLab HTTP transport is deferred.'))
        },
        baseUrl: 'https://gitlab.deferred.invalid',
        projectPath: 'group/project',
        reveal: deferredGitLabError
      })
    })
  )

  // GitHub connector: the flagship dev actuator (spec §4.3). The offline
  // foundation ships the descriptor + dispatch table + the SSRF/HMAC/normalize/
  // auth core; the LIVE REST transport and the cloud webhook ingress are DEFERRED
  // (foundation slice) — `deferredGitHubTransport` fails loudly if an action
  // reaches the wire. Auth is the PAT path bound to the main-only keychain reveal
  // (App-installation auth is built in `github-auth.ts` for when the fork flips).
  // No webhook server is started here (cloud ingress deferred); trigger
  // subscriptions register but stay dormant. Mutations NEVER auto-run — a write
  // fires only because a gated action node invoked it (§9).
  // The keychain-reveal binding is DEFERRED alongside the live transport: until
  // real REST lands, auth is never resolved, so the reveal is a loud stub (the
  // main-only keychain reveal exit is bound at live wiring, mirroring Woo).
  const deferredGitHubReveal = (): never => {
    throw new Error(
      'GitHub live auth is not wired yet — the offline connector core is in place, ' +
        'but keychain reveal + real HTTP land in a follow-up (foundation slice).'
    )
  }
  integrationRegistry.registerConnector(
    'github',
    new GitHubConnector({
      api: new GitHubRestApi({
        transport: deferredGitHubTransport(),
        auth: new PatAuth(deferredGitHubReveal)
      })
    })
  )

  // Slack connector: the CROSS-CUTTING control connector whose headline export is
  // localflow's FIRST real ApprovalPort (§3) — wired over the stub below. The
  // live Socket-Mode WS + Web API HTTPS transport are DEFERRED (foundation
  // slice), exactly like Shopify's live transport: the descriptor, block-kit
  // builders, approval port, connector dispatch, and Events-path verifier are all
  // in place and mock-tested; only the real network exit lands in a follow-up.
  const slackConfig = parseSlackConfig(loadIntegrationsConfig(join(userData, 'config.json')).slack)
  const slackChannel = slackConfig?.defaultChannel ?? ''
  const slackApi = new SlackWebApi({ transport: slackDeferredTransport() })
  const slackConnected =
    integrationRegistry.get('slack')?.status() === 'connected' && slackChannel.length > 0
  // The ApprovalPort is CONNECTOR-AGNOSTIC (§3, §7): built once, it services every
  // gate in every flow. It only replaces the safe-reject stub when Slack is
  // actually connected — otherwise a gate keeps stopping cleanly (never hanging).
  // A holder breaks the port↔connector cycle: the port emits `approval.responded`
  // through the connector, which is assigned just below (resolved at call time).
  const slackRef: { connector?: SlackConnector } = {}
  const slackApprovalPort = slackConnected
    ? new SlackApprovalPort({
        api: slackApi,
        channel: slackChannel,
        onDecision: (decision) => slackRef.connector?.onApprovalDecision(decision)
      })
    : undefined
  const slackConnector = new SlackConnector({
    api: slackApi,
    defaultChannel: slackChannel,
    approvals: slackApprovalPort
  })
  slackRef.connector = slackConnector
  integrationRegistry.registerConnector('slack', slackConnector)

  // Generic HTTP / webhook connector: the catch-all escape-hatch (spec §4.3).
  // The OUTGOING half (`http.get`/`http.send`) is GREEN and fully wired — a real
  // fetch transport behind the SSRF guard, per-node secrets revealed under the
  // COMPOSITE keychain key `http:<nodeId>:<secretRef>` (§7). The INCOMING
  // `webhook.received` trigger is Half 2 (ingress + subscribe-seam extension),
  // registered as a legible deferred no-op until it lands.
  const httpTokens = new HttpTokenStore(integrationCreds)
  integrationRegistry.registerConnector(
    'http',
    new HttpConnector({
      client: new HttpClient({ transport: new FetchHttpTransport() }),
      reveal: (nodeId, secretRef) => httpTokens.revealNodeSecret(nodeId, secretRef)
    })
  )

  // Stripe connector: the payments/refunds/disputes dispatch behind the registry
  // seam (§4.3, §4.4). The live HTTPS transport (Authorization: Bearer rk_… from
  // the keychain) and the webhook tunnel are DEFERRED (foundation slice) —
  // `deferredStripeTransport` fails loudly if an action reaches the wire, so the
  // descriptor, normalizer, and mock-tested dispatch are all in place while real
  // Stripe calls land in a later phase. No money action ever auto-runs: mutations
  // fire ONLY via a gated action node the author drew (§9).
  integrationRegistry.registerConnector(
    'stripe',
    new StripeConnector({
      api: new StripeApiClient({ transport: deferredStripeTransport() })
    })
  )

  const themesDir = join(userData, 'themes')
  ensureThemesSeeded(themesDir)

  const endpoint = await startHookServer((e) => manager.applyHookEvent(e))
  if (process.env['LOCALFLOW_E2E'] === '1') {
    writeFileSync(
      join(userData, 'endpoint.json'),
      JSON.stringify({ port: endpoint.port, token: endpoint.token }),
      { mode: 0o600 }
    )
  }

  const guardBin = resolveGuardBinary({
    packaged: app.isPackaged,
    repoRoot: join(__dirname, '..', '..'),
    resourcesPath: process.resourcesPath
  })
  const guardAuditLog = join(userData, 'guard-audit.jsonl')
  // Per-pane invocation markers for the Codex guard self-verify badge. Cleared
  // and recreated at startup so the watcher arms on a clean slate and no stale
  // cross-run marker can be mistaken for a live write (hygiene, not correctness
  // — fs.watch only reports changes, never pre-existing files). Best-effort,
  // mirrors captureStore.clear().
  const guardSeenDir = join(userData, 'guard-seen')
  try {
    rmSync(guardSeenDir, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
  try {
    mkdirSync(guardSeenDir, { recursive: true })
  } catch {
    /* best-effort */
  }
  const guardProvider = (): import('./guard-hook').ResolvedGuard | null =>
    guardBin
      ? {
          bin: guardBin,
          auditLog: guardAuditLog,
          packs: registry.getGuardPacks(),
          seenDir: guardSeenDir
        }
      : null
  const operatorGuard = makeOperatorGuard({
    resolveBinary: () => guardBin, // resolved once at line 180; null when none bundled
    getPacks: () => registry.getGuardPacks() // AgentRegistry — same source G2 hooks use
  })

  const manager = new SessionManager({
    settingsDir: userData,
    port: endpoint.port,
    token: endpoint.token,
    guard: guardProvider,
    pathExists: existsSync
  })
  managerRef = manager

  const specFor = (agentId: AgentId, customCommand?: string): SpawnSpec => ({
    agentId,
    command: registry.commandFor(agentId, customCommand),
    resumeArgs: registry.argsFor(agentId, true),
    startArgs: registry.argsFor(agentId, false),
    hookAdapter: registry.hookAdapter(agentId),
    extraArgs: registry.extraArgsFor(agentId),
    env: registry.envFor(agentId)
  })

  // A destroyed BrowserWindow still non-null: guard every send, because pty
  // output keeps streaming while the app tears down (crash: "Object has been
  // destroyed" dialogs during quit/reload otherwise).
  const sendToWindow = (channel: string, ...args: unknown[]): void => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
  }

  const grants = new OperatorGrantStore()
  // Named paneRegistry, not registry — `registry` above is already the
  // AgentRegistry instance used throughout this scope.
  const paneRegistry = new PaneRegistry(manager)
  // Rolling per-environment action log (newest last, capped). In-memory only —
  // the feed is deliberately not persisted across restarts (spec "Out of scope").
  const activity = new Map<number, ActivityEntry[]>()
  const consoleBus = new ConsoleEventBus()

  // One append path for the per-environment action log: cap, store, push live.
  const pushActivity = (env: number, entry: ActivityEntry): void => {
    const log = activity.get(env) ?? []
    log.push(entry)
    if (log.length > 200) log.splice(0, log.length - 200)
    activity.set(env, log)
    sendToWindow('operator:activity', env, entry)
    consoleBus.emit(toOperatorEvent(env, entry))
  }

  const browserBridge = new BrowserBridge()
  const captureStore = new CaptureStore(join(userData, 'captures'))
  const browserControl = new WebviewBrowserControl(browserBridge, captureStore, undefined, {
    emitBatch: (inputs) => consoleBus.emitBatch(inputs),
    environmentFor: (handle) => manager.get(handle)?.environment ?? 1
  })
  const watchpoints = new WatchpointRegistry()

  // Extracted so the Flow Engine's PaneDriver can drive panes through the SAME
  // control-API router (handleRequest) — the engine is an operator client, not a
  // privileged SessionManager caller, so the capability boundary + lfguard guard
  // apply to flow work identically.
  const controlDeps: ControlDeps = {
    registry: paneRegistry,
    grants,
    manager,
    panes: {
      // Thin binding: the real logic lives in pane-ops.ts as a pure,
      // dependency-injected function so it's unit-testable without the
      // control server (same shape as addCompanionPane).
      create: (environment: number, req: OperatorPaneRequest): SessionInfo | null =>
        operatorCreatePane(manager, specFor, environment, req)
    },
    browser: browserControl,
    captures: captureStore,
    watchpoints,
    onActivity: pushActivity,
    onCapture: (cap) => consoleBus.emit(toCaptureEvent(cap)),
    guard: operatorGuard,
    onGuardBlock: (r, env) => consoleBus.emit(toGuardEvent(r, env))
  }
  const control = await startControlServer(controlDeps)
  consoleBus.subscribe((event) => sendToWindow('console:event', event))
  const stopGuardTail = startGuardAuditTail({
    path: guardAuditLog,
    onRecords: (records) => {
      for (const r of records) {
        const env = manager.list().find((s) => s.id === r.tag)?.environment ?? 1
        consoleBus.emit(toGuardEvent(r, env))
      }
    }
  })
  const stopGuardSeenWatch = startGuardSeenWatch({
    dir: guardSeenDir,
    onSeen: (tag) => manager.markGuardObserved(tag)
  })

  // ── Flow Engine (sub-project #2), wired to the real Integrations Hub (#1) ────
  // Opt-in and inert by default: the `flows` config block is off unless a user
  // turns it on, so with no flow configured nothing subscribes and nothing runs.
  // The engine drives panes only as an OPERATOR CLIENT — via the PaneDriver over
  // the same control-API router grants + lfguard already gate.
  const flowsFile = join(userData, 'flows.json')
  const flowConfigFile = join(userData, 'config.json')
  const flowsConfig = loadFlowsConfig(flowConfigFile)
  const paneDriver = new PaneDriver({ controlDeps, grants })
  // The ApprovalPort: the Slack connector supplies localflow's FIRST real one
  // (§3, §7). When Slack is `connected` it REPLACES the stub and services EVERY
  // gate in every flow — any gated action becomes approvable from a phone. When
  // Slack is not connected the safe-reject stub stays: a gate cleanly REJECTS
  // rather than silently auto-proceeding or hanging (a human "no" is not a
  // failure). The engine and gate-runner are untouched — both already take an
  // `ApprovalPort`.
  const flowApprovals: ApprovalPort = slackApprovalPort ?? {
    requestApproval: async (req) => {
      pushActivity(flowsConfig.environment, {
        at: Date.now(),
        route: 'flow:gate',
        detail: `Gate '${req.nodeId}' needs approval — no approval surface is connected, rejecting safely.`
      })
      return false
    }
  }
  const loadedFlows = loadFlows(flowsFile)
  for (const notice of loadedFlows.notices) flowNotices.report(notice)
  const flowEngine = new FlowEngine({
    flows: loadedFlows.flows,
    config: flowsConfig,
    registry: integrationRegistry,
    approvals: flowApprovals,
    driver: paneDriver,
    manager
  })
  flowEngine.onEvent((event) => sendToWindow('flow:run-event', event))
  // Subscribe trigger streams for enabled flows. No-op when the flows block is
  // disabled (the default) — the "works with no flow configured" guarantee holds.
  flowEngine.start()

  // Per-id CRUD over the engine's single real flows.json store, adapting the
  // canvas IPC (list/get/save/delete) to the engine's loadFlows/saveFlows.
  const flowMtime = (): number => {
    try {
      return statSync(flowsFile).mtimeMs
    } catch {
      return Date.now()
    }
  }
  const listFlowSummaries = (): FlowSummary[] => {
    const mt = flowMtime()
    return loadFlows(flowsFile).flows.map((g) => summarize(g, mt))
  }
  const getFlow = (id: string): FlowGraph | null =>
    loadFlows(flowsFile).flows.find((g) => g.id === id) ?? null
  const saveFlow = (
    graph: FlowGraph
  ): { ok: true; summary: FlowSummary } | { ok: false; error: string } => {
    if (!isFlowGraph(graph)) {
      return {
        ok: false,
        error:
          "This flow couldn't be saved — it was malformed (an unknown node type, a non-object config, or an arrow pointing at a missing node). Nothing was written."
      }
    }
    const flows = loadFlows(flowsFile).flows.filter((g) => g.id !== graph.id)
    flows.push(graph)
    const res = saveFlows(flowsFile, flows)
    if (!res.ok) return { ok: false, error: res.error }
    return { ok: true, summary: summarize(graph, flowMtime()) }
  }
  const deleteFlow = (id: string): void => {
    const flows = loadFlows(flowsFile).flows.filter((g) => g.id !== id)
    saveFlows(flowsFile, flows)
  }

  app.on('before-quit', () => {
    control.close()
    stopGuardTail()
    stopGuardSeenWatch()
    flowEngine.stop()
    // The scratch dir only holds handoff assets for live sessions; nothing in
    // it is meaningful across a restart (captures themselves are in-memory).
    captureStore.clear()
  })
  const launchTracker = new OperatorLaunchTracker()

  // Grant/revoke mirrored into an EXISTING OpenClaw config (the block the
  // manual setup documents): grant writes skills.entries.localflow.env,
  // revoke removes exactly that entry. Missing file → no-op (never created);
  // any failure is NON-FATAL — the grant/revoke itself always proceeds, with
  // a console warning + an operator:activity entry. Token values are never
  // logged. The env override keeps e2e runs away from a real ~/.openclaw.
  const openclawConfig = process.env['LOCALFLOW_OPENCLAW_CONFIG'] ?? defaultOpenclawConfig()
  const reportSkillEnv = (env: number, verb: 'write' | 'remove', result: SkillEnvResult): void => {
    if (result.ok) return
    console.warn(`openclaw config skill-env ${verb} failed: ${result.reason} (${openclawConfig})`)
    pushActivity(env, {
      at: Date.now(),
      route: 'openclaw:config',
      detail: `skill env ${verb} failed: ${result.reason}`
    })
  }
  const grantOperator = (env: number): string => {
    const token = grants.grant(env)
    reportSkillEnv(
      env,
      'write',
      writeSkillEnv(openclawConfig, `http://127.0.0.1:${control.port}`, token)
    )
    return token
  }
  const revokeOperator = (env: number): void => {
    grants.revoke(env)
    reportSkillEnv(env, 'remove', removeSkillEnv(openclawConfig))
  }

  // User-path OpenClaw pane grant, mirroring session:create's openclaw branch:
  // capture wasGranted BEFORE granting (revoke ownership — a pane that reused
  // an existing grant must not revoke it on close), hand back the operator
  // credentials to inject into the spawn env, and a `register` to track the
  // launch so revoke-on-close keeps working. Shared by group:addPane and
  // templates:create — the operator control-API route intentionally does NOT
  // use this (it rejects openclaw upstream in parseOperatorPaneRequest).
  const grantOpenclawPane = (
    environment: number
  ): { env: Record<string, string>; register: (paneId: string) => void } => {
    const wasGranted = grants.isGranted(environment)
    const token = grantOperator(environment)
    return {
      env: credentialEnv(`http://127.0.0.1:${control.port}`, token),
      register: (paneId: string) => launchTracker.onLaunch(environment, paneId, wasGranted)
    }
  }

  ipcMain.on('browser:register', (_e, handle: string, webContentsId: number) => {
    if (typeof handle === 'string' && Number.isInteger(webContentsId)) {
      browserBridge.register(handle, webContentsId)
      browserControl.startNetworkTap(handle)
    }
  })
  ipcMain.on('browser:unregister', (_e, handle: string) => {
    if (typeof handle === 'string') browserBridge.unregister(handle)
  })

  const webviewPolicy = installWebviewPolicy({
    bindings: keybindings,
    onAction: (action) => sendToWindow('keybinding:action', action)
  })

  manager.onData((id, data) => sendToWindow('session:data', id, data))
  manager.onStatus((id, status) => {
    sendToWindow('session:status', id, status)
    // The Flow Engine JOINS this existing status feed as one more subscriber (it
    // never registers its own pty listeners): a flow-driven agent pane's
    // terminal transition resolves its waiting node. A pane handle IS its
    // session id, so `id` matches the handle the PaneDriver returned.
    flowEngine.onPaneStatus(id, status)
    // Opt-in early teardown (operatorRevokeOnExit in config.json, read fresh
    // like editorCommand): when the last live pty of a launch-owned
    // environment exits or is closed, revoke right away instead of waiting
    // for the session's deletion. Default OFF keeps close→restart working.
    if (status === 'exited') {
      const env = launchTracker.onPtyExit(
        id,
        (sid) => manager.get(sid)?.status !== 'exited',
        loadOperatorRevokeOnExit(join(userData, 'config.json'))
      )
      if (env !== null) revokeOperator(env)
    }
  })
  manager.onActivity((id, entry) => {
    sendToWindow('activity:event', id, entry)
    const env = manager.list().find((s) => s.id === id)?.environment ?? 1
    consoleBus.emit(toStatusEvent(id, env, entry))
  })
  // No-clobber invariant: auto-save may overwrite sessions.json ONLY when the
  // load proved it safe (ENOENT first run, a clean load, or corruption whose
  // backup succeeded). If the file was unreadable — or corruption we couldn't
  // back up — the intact bytes are still on disk, so we must NOT save empty
  // over them. Assigned from the load below (before the restore loop, which
  // itself fires onSessionsChanged); defaults false so nothing can race a save
  // ahead of the decision.
  let persistenceSafe = false
  manager.onSessionsChanged(() => {
    const currentIds = new Set(manager.list().map((s) => s.id))
    for (const id of launchTracker.trackedIds()) {
      if (!currentIds.has(id)) {
        const env = launchTracker.onClose(id)
        if (env !== null) revokeOperator(env)
      }
    }
    // The load couldn't guarantee the on-disk file is disposable — skip the
    // write so a transient glitch can't reset the workspace to empty.
    if (!persistenceSafe) return
    const result = saveState(sessionsFile, {
      sessions: manager
        .list()
        .map(({ id, cwd, agentId, command, name, environment, kind, url, groupId }) => ({
          id,
          cwd,
          agentId,
          command,
          name,
          environment,
          kind,
          url,
          groupId
        })),
      groups: manager.listGroups()
    })
    // Router de-dupes an already-shown error and buffers one raised before the
    // window exists (flushed on did-finish-load), so a cold-start save failure
    // still reaches the user instead of being permanently muted.
    persistenceNotices.report(result.ok ? null : result.error)
  })

  const savedState = loadSavedState(sessionsFile)
  persistenceSafe = savedState.safeToPersist
  const persistenceStartupNotice = savedState.error ?? null
  ipcMain.handle('persistence:getNotice', () => persistenceStartupNotice)
  manager.restoreGroups(savedState.groups)
  for (const saved of savedState.sessions) {
    if (saved.kind === 'browser') {
      // restoreBrowser validates the stored URL; a hand-corrupted entry is
      // dropped rather than restored as an unloadable pane.
      manager.restoreBrowser(
        saved.id,
        saved.url ?? '',
        saved.name,
        saved.environment,
        saved.groupId
      )
      continue
    }
    const agentId = VALID_AGENTS.includes(saved.agentId as AgentId)
      ? (saved.agentId as AgentId)
      : 'claude'
    // A saved custom session keeps its stored command verbatim.
    const spec = agentId === 'custom' ? specFor(agentId, saved.command ?? '') : specFor(agentId)
    manager.restore(saved.id, saved.cwd, spec, saved.name, saved.environment, saved.groupId)
  }

  ipcMain.handle(
    'session:create',
    async (_e, agentId: AgentId, cwd?: string, customCommand?: string, environment?: number) => {
      if (!VALID_AGENTS.includes(agentId)) return null
      // customCommand is optional, but a non-string over IPC would throw on
      // the .trim() calls below — reject cleanly, same posture as the
      // VALID_AGENTS guard above.
      if (customCommand !== undefined && typeof customCommand !== 'string') return null
      if (agentId === 'custom' && !customCommand?.trim()) return null
      // Landing always sends a resolved cwd now (a default, or the user's
      // typed/picked choice) — the dialog is a fallback for the rare caller
      // that doesn't (an old/malformed IPC call), not the primary path.
      let dir = typeof cwd === 'string' ? (expandTypedPath(cwd, homedir()) ?? undefined) : undefined
      if (!dir) {
        const result = await dialog.showOpenDialog(win!, {
          properties: ['openDirectory', 'createDirectory'],
          title: 'Choose a project folder for the new session'
        })
        if (result.canceled || result.filePaths.length === 0) return null
        dir = result.filePaths[0]
      }
      let spec = specFor(agentId, customCommand?.trim())
      let launch: { environment: number; wasGranted: boolean } | null = null
      if (agentId === 'openclaw') {
        const env = clampEnvironment(environment)
        const wasGranted = grants.isGranted(env)
        const token = grantOperator(env)
        spec = {
          ...spec,
          env: { ...spec.env, ...credentialEnv(`http://127.0.0.1:${control.port}`, token) }
        }
        launch = { environment: env, wasGranted }
      }
      const created = manager.create(dir, spec, clampEnvironment(environment))
      if (launch) launchTracker.onLaunch(launch.environment, created.id, launch.wasGranted)
      if (created.status !== 'exited') {
        registry.recordLastAgent(agentId, customCommand?.trim())
      }
      return created
    }
  )
  // Sensible default new-session cwd (M-pathux): most recent terminal
  // session's cwd, else home — lets Landing skip the folder picker by
  // default while keeping it one click away via session:chooseFolder.
  ipcMain.handle('session:defaultCwd', () =>
    resolveDefaultCwd(manager.list(), homedir(), existsSync)
  )
  ipcMain.handle('session:chooseFolder', async () => {
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose a project folder for the new session'
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })
  ipcMain.handle('session:restart', (_e, id: string, fresh?: boolean) => {
    // Restarting a launched OpenClaw session after its grant was revoked
    // (cockpit toggle, operatorRevokeOnExit, app restart) would spawn it with
    // stale/no credentials. Re-grant and refresh the injected env first.
    // wasGranted is captured BEFORE grant, exactly like session:create — that
    // ordering decides revoke ownership (this restart created the grant, so
    // it owns the eventual revoke).
    const s = manager.get(id)
    if (
      s &&
      s.kind === 'terminal' &&
      s.agentId === 'openclaw' &&
      s.status === 'exited' &&
      !grants.isGranted(s.environment)
    ) {
      const wasGranted = grants.isGranted(s.environment)
      const token = grantOperator(s.environment)
      manager.updateSpecEnv(id, credentialEnv(`http://127.0.0.1:${control.port}`, token))
      launchTracker.onLaunch(s.environment, id, wasGranted)
    }
    return manager.restart(id, fresh === true)
  })
  ipcMain.handle('session:closeTerminal', (_e, id: string) => manager.closeTerminal(id))
  ipcMain.handle('session:delete', (_e, id: string) => manager.deleteSession(id))
  ipcMain.handle('session:rename', (_e, id: string, name: string) => manager.rename(id, name))
  ipcMain.handle('session:setEnvironment', (_e, id: string, environment: number) =>
    manager.setEnvironment(id, environment)
  )
  ipcMain.handle('group:create', (_e, name: string, environment: number) =>
    typeof name === 'string' && name.trim().length > 0
      ? manager.createGroup(name, environment)
      : null
  )
  ipcMain.handle('group:rename', (_e, id: string, name: string) =>
    typeof id === 'string' && typeof name === 'string' ? manager.renameGroup(id, name) : null
  )
  ipcMain.handle('group:assign', (_e, paneId: string, groupId: string | null) =>
    typeof paneId === 'string' && (groupId === null || typeof groupId === 'string')
      ? manager.assignToGroup(paneId, groupId)
      : null
  )
  ipcMain.handle('group:list', () => manager.listGroups())
  ipcMain.handle('group:addPane', (_e, sourcePaneId: string, req: AddPaneRequest) => {
    // Boundary-validate the request shape — the renderer is not trusted with
    // it (same posture as session:create's VALID_AGENTS check).
    if (typeof sourcePaneId !== 'string' || typeof req !== 'object' || req === null) return null
    if (req.kind === 'terminal') {
      if (!VALID_AGENTS.includes(req.agentId)) return null
      // A non-string customCommand would throw on .trim() — reject rather
      // than surface a TypeError to the bridge (same as session:create).
      if (
        req.agentId === 'custom' &&
        (typeof req.customCommand !== 'string' || !req.customCommand.trim())
      )
        return null
    } else if (req.kind === 'browser') {
      if (typeof req.url !== 'string') return null
    } else {
      return null
    }
    return addCompanionPane(manager, specFor, sourcePaneId, req, grantOpenclawPane)
  })
  ipcMain.handle('session:createBrowser', (_e, url: string, environment?: number) => {
    // Validate at the boundary; manager.createBrowser re-validates (throws),
    // so reject cleanly here instead of surfacing an exception to the bridge.
    if (typeof url !== 'string' || normalizeHttpUrl(url) === null) return null
    return manager.createBrowser(url, clampEnvironment(environment))
  })
  ipcMain.handle('session:setUrl', (_e, id: string, url: string) =>
    typeof url === 'string' ? manager.setUrl(id, url) : null
  )
  ipcMain.handle('templates:list', () => loadSessionTemplates(join(userData, 'config.json')))
  ipcMain.handle(
    'templates:create',
    async (_e, name: string, cwd: string | undefined, environment: number) => {
      if (typeof name !== 'string') return null
      const template = loadSessionTemplates(join(userData, 'config.json')).find(
        (t) => t.name === name
      )
      if (!template) return null
      // Dir-picking logic copied verbatim from session:create — dialog
      // unless under the e2e harness, which passes an explicit cwd.
      let dir = process.env['LOCALFLOW_E2E'] === '1' ? cwd : undefined
      if (!dir) {
        const result = await dialog.showOpenDialog(win!, {
          properties: ['openDirectory', 'createDirectory'],
          title: 'Choose a project folder for the new session'
        })
        if (result.canceled || result.filePaths.length === 0) return null
        dir = result.filePaths[0]
      }
      // Skip panes whose agent binary is missing rather than failing the
      // whole template; 'shell' has no fixed binary to detect, so it's
      // always considered launchable (mirrors AgentRegistry.commandFor).
      const agentInfos = await registry.list()
      const resolvedByAgent = new Map(agentInfos.map((a) => [a.id, a.resolvedPath]))
      const launchable = template.panes.filter(
        (pane) =>
          pane.kind === 'browser' ||
          pane.agentId === 'shell' ||
          !!resolvedByAgent.get(pane.agentId ?? 'claude')
      )
      if (launchable.length === 0) return null
      // Panes are created directly (create/createBrowser + assignToGroup)
      // rather than via addCompanionPane, which derives cwd/environment from
      // an existing source pane — there isn't one yet for the first pane of
      // a brand-new template group.
      const resolvedDir = dir
      const group = manager.createGroup(basename(resolvedDir), environment)
      return launchable.map((pane) => {
        let created: SessionInfo
        if (pane.kind === 'terminal') {
          const agentId = pane.agentId ?? 'claude'
          let spec = specFor(agentId)
          // Same grant + credential injection as session:create's openclaw
          // branch. For a template with several openclaw panes in one
          // environment the grant is captured PER PANE, but grants.grant is
          // idempotent: the first pane owns the revoke (wasGranted=false), each
          // later pane reuses the same token (wasGranted=true) and only adds a
          // tracked session — so the grant is revoked once, when the last of
          // them closes.
          let register: ((paneId: string) => void) | undefined
          if (agentId === 'openclaw') {
            const granted = grantOpenclawPane(environment)
            spec = { ...spec, env: { ...spec.env, ...granted.env } }
            register = granted.register
          }
          created = manager.create(resolvedDir, spec, environment)
          register?.(created.id)
        } else {
          // parseSessionTemplates only ever emits a browser pane with a
          // validated url, so this is never actually undefined.
          created = manager.createBrowser(pane.url!, environment)
        }
        return manager.assignToGroup(created.id, group.id) ?? created
      })
    }
  )
  ipcMain.handle('git:status', (_e, id: string) => {
    // cwd is resolved from the session record here — NEVER trusted from the
    // renderer. Browser panes (and unknown ids) have no working tree.
    const s = manager.get(id)
    if (!s || s.kind !== 'terminal') return { repo: false }
    return gitStatus(s.cwd)
  })
  ipcMain.handle('git:diff', (_e, id: string, path: string, staged: boolean) => {
    const s = manager.get(id)
    if (!s || s.kind !== 'terminal' || typeof path !== 'string') {
      return { text: '', truncated: false }
    }
    return gitDiff(s.cwd, path, staged === true)
  })

  // Escape-hatch tool resolution. An absolute-path env override is honored via
  // existsSync (tests point these at nonexistent/fixture paths so the suite
  // never spawns a real login shell). Otherwise the token is security-gated
  // first: whichViaLoginShell interpolates its argument into a shell line
  // (`$SHELL -ilc "command -v ${bin}"`), so only vetted tokens may reach it —
  // absolute paths (spaces fine) are checked with existsSync and never touch a
  // shell; strict safe-identifier names get the login-shell PATH lookup a GUI
  // app needs; anything else (config.json is user-edited) is unresolvable.
  const resolveTool = (bin: string, override?: string): Promise<string | null> => {
    if (override) return Promise.resolve(existsSync(override) ? override : null)
    switch (gateBin(bin)) {
      case 'absolute':
        return Promise.resolve(existsSync(bin) ? bin : null)
      case 'login-shell':
        return whichViaLoginShell(bin)
      case 'rejected':
        return Promise.resolve(null)
    }
  }

  // Probed once and cached: a login-shell lookup is expensive, and the Changes
  // view re-enters often. Newly installed tools / edited editorCommand apply on
  // next launch — same resolution-caching trade-off AgentRegistry makes.
  let capsCache: Capabilities | null = null
  ipcMain.handle('git:capabilities', async (): Promise<Capabilities> => {
    if (capsCache) return capsCache
    const editorCommand = loadEditorCommand(join(userData, 'config.json'))
    // Quote-aware split: null (unbalanced quote) or an empty first token means
    // the configured command is unusable — report the editor unavailable.
    const editorBin = splitCommandLine(editorCommand)?.[0] || null
    const [lazygitPath, editorPath] = await Promise.all([
      resolveTool('lazygit', process.env['LOCALFLOW_LAZYGIT_BIN']),
      editorBin
        ? resolveTool(editorBin, process.env['LOCALFLOW_EDITOR_BIN'])
        : Promise.resolve<string | null>(null)
    ])
    capsCache = {
      lazygit: describeTool('lazygit', lazygitPath),
      editor: { ...describeTool(editorBin ?? editorCommand, editorPath), command: editorCommand }
    }
    return capsCache
  })

  ipcMain.handle('git:openLazygit', async (_e, id: string) => {
    const s = manager.get(id)
    if (!s || s.kind !== 'terminal' || !s.cwd) return null
    const lazygitPath = await resolveTool('lazygit', process.env['LOCALFLOW_LAZYGIT_BIN'])
    if (!lazygitPath) return null
    // Reuse the custom-agent plumbing verbatim: a durable custom session running
    // lazygit (by resolved absolute path — a GUI app's env lacks the login PATH)
    // in the reviewed session's OWN cwd + environment. cwd comes from the record.
    return manager.create(s.cwd, specFor('custom', lazygitPath), s.environment)
  })

  ipcMain.handle('git:openEditor', async (_e, id: string) => {
    const s = manager.get(id)
    if (!s || s.kind !== 'terminal' || !s.cwd) return false
    const launch = editorLaunch(loadEditorCommand(join(userData, 'config.json')), s.cwd)
    if (!launch) return false
    const resolved = await resolveTool(launch.bin, process.env['LOCALFLOW_EDITOR_BIN'])
    if (!resolved) return false
    try {
      // External, detached, fire-and-forget process — never a pane. stdio
      // ignored + unref so it can neither hold quit nor be killed by our pipe
      // lifetime; async spawn failures get a log line instead of vanishing.
      const child = spawn(resolved, launch.args, {
        cwd: s.cwd,
        detached: true,
        stdio: 'ignore'
      })
      child.on('error', (err) => console.error('editor launch failed', err))
      child.unref()
    } catch {
      return false
    }
    return true
  })

  ipcMain.handle('session:list', () => manager.list())
  ipcMain.handle('activity:get', (_e, id: string) => manager.getActivity(id))
  ipcMain.handle('session:peek', (_e, id: string, maxLines?: number) => {
    // Clamp at the boundary: the renderer is not trusted with the range.
    const n = Number(maxLines)
    return manager.peek(id, Math.min(Math.max(Number.isFinite(n) ? Math.trunc(n) : 5, 1), 20))
  })
  ipcMain.handle('session:snapshot', (_e, id: string) => manager.snapshot(id))
  ipcMain.on('session:write', (_e, id: string, data: string) => manager.write(id, data))
  ipcMain.on('session:resize', (_e, id: string, cols: number, rows: number) =>
    manager.resize(id, cols, rows)
  )
  ipcMain.on('shell:openExternal', (_e, url: string) => {
    if (typeof url === 'string' && isHttpUrl(url)) void shell.openExternal(url)
  })

  ipcMain.handle('keybindings:get', () => keybindings)

  // One write path for every keybinding change: persist (hand-editable file
  // stays the source of truth), update the in-memory copy, re-point the
  // webview key-forwarder, and push the full map so the renderer dispatcher
  // re-parses. No restart.
  const applyKeybindings = (next: Record<KeyAction, string>): Record<KeyAction, string> => {
    keybindings = next
    writeKeybindings(join(userData, 'keybindings.json'), next)
    webviewPolicy.updateBindings(next)
    sendToWindow('keybindings:changed', next)
    return next
  }
  ipcMain.handle('keybindings:set', (_e, action: string, binding: string): BindingChangeResult => {
    if (!(action in DEFAULT_BINDINGS) || typeof binding !== 'string') {
      return { ok: false, reason: 'invalid', conflicts: [] }
    }
    // Conflicts are rejected here, not just surfaced in the UI: main's IPC is
    // the gatekeeper for keybindings.json, so no caller can persist a combo
    // another action already holds. A no-op re-set skips the write + push.
    const result = applyBindingChange(keybindings, action as KeyAction, binding)
    if (result.ok && result.changed) applyKeybindings(result.bindings)
    return result
  })
  ipcMain.handle('keybindings:reset', (_e, action: string) => {
    if (!(action in DEFAULT_BINDINGS)) return keybindings
    return applyKeybindings({
      ...keybindings,
      [action as KeyAction]: DEFAULT_BINDINGS[action as KeyAction]
    })
  })
  ipcMain.handle('keybindings:resetAll', () => applyKeybindings({ ...DEFAULT_BINDINGS }))
  ipcMain.handle('environments:getNames', () => loadEnvironmentNames(join(userData, 'config.json')))

  ipcMain.handle('agents:list', () => registry.list())
  ipcMain.handle('agents:getLastAgent', () => registry.getLastAgent())
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
  ipcMain.handle(
    'agents:setPathTyped',
    async (_e, agentId: AgentId, path: string): Promise<AgentPathTypedResult | null> => {
      if (!VALID_AGENTS.includes(agentId) || agentId === 'custom') return null
      if (typeof path !== 'string') return null
      const expanded = expandTypedPath(path, homedir())
      if (!expanded) {
        // The renderer's looksLikeTypedPath is a looser syntactic pre-check
        // (it enables the "Use path" button); this authoritative check can
        // still reject something it accepted — e.g. ~otheruser/proj (no
        // portable way to resolve another user's home) or a typo missing
        // the leading / or ~. Name the real reason instead of returning
        // null and leaving the renderer to silently do nothing.
        return {
          ok: false,
          reason:
            "That isn't a valid absolute path — use /… or ~/… (another user's ~ isn't supported)."
        }
      }
      registry.setPath(agentId, expanded)
      return { ok: true, agents: await registry.list() }
    }
  )
  ipcMain.handle('operator:grant', (_e, environment: number): GrantInfo => {
    const env = clampEnvironment(environment)
    const token = grantOperator(env)
    const info: GrantInfo = {
      environment: env,
      endpoint: `http://127.0.0.1:${control.port}`,
      token
    }
    // Under e2e, expose the grant to the scripted control-API client on disk
    // (mirrors the hook server's endpoint.json handshake).
    if (process.env['LOCALFLOW_E2E'] === '1') {
      writeFileSync(join(userData, `operator-grant-${env}.json`), JSON.stringify(info), {
        mode: 0o600
      })
    }
    return info
  })
  ipcMain.handle('operator:revoke', (_e, environment: number) => {
    revokeOperator(clampEnvironment(environment))
  })
  ipcMain.handle('operator:status', (_e, environment: number): OperatorStatus => {
    const env = clampEnvironment(environment)
    return {
      environment: env,
      granted: grants.isGranted(env),
      connected: grants.isConnected(env),
      endpoint: grants.isGranted(env) ? `http://127.0.0.1:${control.port}` : undefined,
      activity: activity.get(env) ?? []
    }
  })
  ipcMain.handle('operator:captures', (_e, environment: number) =>
    captureStore.list(clampEnvironment(environment))
  )
  ipcMain.handle('console:list', () => consoleBus.snapshot())
  ipcMain.handle('console:readScreenshot', (_e, path: string) =>
    typeof path === 'string' ? captureStore.readScreenshotDataUri(path) : null
  )
  ipcMain.handle('operator:watchpoints', (_e, environment: number) =>
    watchpoints.list(clampEnvironment(environment))
  )
  ipcMain.handle(
    'operator:registerWatchpoint',
    (_e, environment: number, workflow: string, step: string, capture: string[]) =>
      // Same validation path as the control API's POST /watchpoints: the
      // registry rejects malformed fields (returns null) at the boundary.
      watchpoints.register(clampEnvironment(environment), { workflow, step, capture })
  )
  ipcMain.handle(
    'operator:resume',
    (_e, environment: number, captureId: string, approve: boolean) => {
      const env = clampEnvironment(environment)
      const token = captureStore.resolve(env, captureId)
      pushActivity(env, {
        at: Date.now(),
        route: 'operator:resume',
        detail: `${captureId} ${approve ? 'approve' : 'stop'}`
      })
      return token !== null
    }
  )
  ipcMain.handle('agents:setDefaultAgent', (_e, agentId: AgentId) => {
    if (!VALID_AGENTS.includes(agentId)) return null
    registry.setDefaultAgent(agentId)
    return registry.list()
  })
  ipcMain.handle(
    'agents:setOverride',
    async (_e, agentId: AgentId, override: AgentOverride): Promise<AgentOverrideResult | null> => {
      if (!VALID_AGENTS.includes(agentId) || typeof override !== 'object' || override === null) {
        return null
      }
      const result = registry.setAgentOverride(agentId, override)
      if (!result.ok) return result
      return { ok: true, agents: await registry.list() }
    }
  )

  ipcMain.handle('theme:get', () => resolveTheme(themesDir, registry.getTheme()))
  ipcMain.handle('theme:list', () => listThemeNames(themesDir))
  ipcMain.handle('theme:set', (_e, name: string) => {
    if (typeof name !== 'string' || name.length === 0)
      return resolveTheme(themesDir, registry.getTheme())
    registry.setTheme(name)
    const resolved = resolveTheme(themesDir, name)
    sendToWindow('theme:changed', resolved)
    return resolved
  })
  ipcMain.on('theme:openFolder', () => void shell.openPath(themesDir))

  ipcMain.handle('console:getPrefs', () => registry.getConsolePrefs())
  ipcMain.on('console:setPrefs', (_e, prefs: ConsolePrefs) => registry.setConsolePrefs(prefs))

  ipcMain.handle('guard:getPacks', () => registry.getGuardPacks())
  // Security-relevant setting (which lfguard packs are enforced): a bare
  // ipcMain.on fire-and-forget here would mean a config.json write failure
  // (disk full, permission revoked) left the renderer's checkbox showing a
  // pack as enabled while it was never persisted — surfaced instead as a
  // structured result, same shape as keybindings:set / agents:setOverride.
  ipcMain.handle('guard:setPacks', (_e, packs: string[]): GuardPacksResult => {
    if (!Array.isArray(packs) || !packs.every((p) => typeof p === 'string')) {
      return { ok: false, reason: 'invalid pack list' }
    }
    try {
      registry.setGuardPacks(packs)
      return { ok: true, packs: registry.getGuardPacks() }
    } catch (err) {
      return { ok: false, reason: (err as Error).message }
    }
  })
  ipcMain.handle('settings:getAllowTypedPaths', () => registry.getAllowTypedPaths())
  ipcMain.on('settings:setAllowTypedPaths', (_e, allow: boolean) => {
    if (typeof allow === 'boolean') registry.setAllowTypedPaths(allow)
  })

  // Integrations Hub IPC (§4.6). Every handler returns presence/status only —
  // a secret VALUE crosses inbound (setSecret) and is NEVER put in a return or a
  // log. `setField` rejects a secret key and `setSecret` rejects a config key,
  // so the config-vs-keychain routing can't be crossed by a mislabeled call.
  ipcMain.handle('integrations:list', () => integrationRegistry.views())
  ipcMain.handle('integrations:setEnabled', (_e, id: IntegrationId, enabled: boolean) => {
    if (typeof enabled !== 'boolean') return { ok: false, reason: 'enabled must be a boolean' }
    return integrationRegistry.setEnabled(id, enabled)
  })
  ipcMain.handle('integrations:setField', (_e, id: IntegrationId, key: string, value: string) => {
    if (typeof key !== 'string' || typeof value !== 'string') {
      return { ok: false, reason: 'field key and value must be strings' }
    }
    return integrationRegistry.setField(id, key, value)
  })
  ipcMain.handle('integrations:setSecret', (_e, id: IntegrationId, key: string, value: string) => {
    if (typeof key !== 'string' || typeof value !== 'string') {
      return { ok: false, reason: 'secret key and value must be strings' }
    }
    return integrationRegistry.setSecret(id, key, value)
  })
  ipcMain.handle('integrations:clearSecret', (_e, id: IntegrationId, key?: string) =>
    integrationRegistry.clearSecret(id, typeof key === 'string' ? key : undefined)
  )

  // --- Flow Canvas (sub-project #3) → real Engine (#2) + Hub registry (#1) ----
  // The canvas palette reads the REAL Integrations Hub registry (resolved
  // descriptors). Flows persist through the engine's real flows.json store, and
  // `flow:run` drives the REAL engine (see the construction block above).
  ipcMain.handle('integration:list', () => resolveDescriptors(integrationRegistry.descriptors()))
  // The built-in flow templates are config-as-code (a constant) — read-only,
  // secret-free, no store round-trip. Seeds the canvas "New from template" picker.
  ipcMain.handle('flow:list-templates', () => BUILTIN_FLOW_TEMPLATES)
  ipcMain.handle('flow:list', () => listFlowSummaries())
  ipcMain.handle('flow:get', (_e, id: string) => getFlow(id))
  ipcMain.handle('flow:save', (_e, graph: FlowGraph) => {
    const result = saveFlow(graph)
    // A later save failure is also pushed as a notice (the return value already
    // carries it for the immediate caller; the push mirrors onPersistenceNotice
    // so a passive banner can surface it too).
    flowNotices.report(result.ok ? null : result.error)
    return result
  })
  ipcMain.handle('flow:delete', (_e, id: string) => deleteFlow(id))
  ipcMain.handle('flow:run', (_e, id: string) => {
    const graph = getFlow(id)
    if (!graph) {
      return {
        ok: false,
        error: `That flow couldn't be found — it may have been deleted. Save it again, then Run. (id: ${id})`
      }
    }
    // A manual run from the canvas is an explicit user action: synthesize an
    // empty seed event and hand the SAVED graph to the real engine. The engine
    // re-validates through the STRICT parser here — listing/editing stayed
    // LENIENT so a draft (e.g. an unreachable node) round-trips through save,
    // but nothing is dispatched for an unrunnable graph. Returns the run id
    // immediately; the walk proceeds async and streams over `flow:run-event`.
    return flowEngine.run(graph, { eventId: randomUUID(), payload: {} })
  })

  createWindow()
})

app.on('before-quit', () => {
  // Stop pty streams before windows die — their late output must never
  // reach a destroyed window.
  managerRef?.disposeAll()
})

app.on('window-all-closed', () => {
  app.quit()
})
