import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Same launch shape as smoke.spec.ts's launchApp, plus two optional
 * additions this spec needs: `sessionTemplates` (written into config.json's
 * own key, read fresh by main's loadSessionTemplates — see
 * src/main/index.ts) and `resumeDeadArg` (LOCALFLOW_E2E_RESUME_DEAD_ARG,
 * consumed by fake-claude.sh's resume dead-end branch, see that fixture's
 * comment). Neither is set by default, so tests that don't need them get
 * byte-identical behavior to smoke.spec.ts's launchApp.
 */
function launchApp(
  userData: string,
  opts: {
    agentPaths?: Record<string, string>
    sessionTemplates?: unknown[]
    resumeDeadArg?: string
  } = {}
): Promise<ElectronApplication> {
  writeFileSync(
    join(userData, 'config.json'),
    JSON.stringify({
      agentPaths: {
        codex: '/nonexistent/codex',
        gemini: '/nonexistent/gemini',
        ...opts.agentPaths
      },
      ...(opts.sessionTemplates ? { sessionTemplates: opts.sessionTemplates } : {})
    })
  )
  return electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      LOCALFLOW_E2E: '1',
      LOCALFLOW_USER_DATA: userData,
      LOCALFLOW_CLAUDE_BIN: join(here, '../fixtures/fake-claude.sh'),
      LOCALFLOW_LAZYGIT_BIN: '/nonexistent/lazygit',
      LOCALFLOW_EDITOR_BIN: '/nonexistent/code',
      LOCALFLOW_E2E_GO: join(userData, 'e2e-go'),
      ...(opts.resumeDeadArg ? { LOCALFLOW_E2E_RESUME_DEAD_ARG: opts.resumeDeadArg } : {})
    }
  })
}

/**
 * Read and parse sessions.json, tolerating both the legacy bare-array shape
 * and the versioned `{ sessions, groups }` shape (see src/main/persistence.ts
 * and smoke.spec.ts's identical readSavedSessions helper).
 */
function readSavedGroups(userData: string): Array<Record<string, unknown>> {
  const data = JSON.parse(readFileSync(join(userData, 'sessions.json'), 'utf8'))
  return Array.isArray(data) ? [] : (data.groups ?? [])
}

interface Session {
  id: string
  environment: number
  groupId?: string
  cwd: string
  agentId: string
}
interface Group {
  id: string
  name: string
  environment: number
}
type AddPaneReq = { kind: 'terminal'; agentId: string } | { kind: 'browser'; url: string }

/** Renderer-side shape this spec calls through `window.localflow` — a
 *  narrowed view of LocalflowApi (src/shared/api.ts), typed locally so this
 *  file has no import-time dependency on the renderer bundle. */
type Api = {
  localflow: {
    createSession(
      agentId: string,
      cwd?: string,
      customCommand?: string,
      environment?: number
    ): Promise<Session | null>
    createTemplate(
      name: string,
      cwd: string | undefined,
      environment: number
    ): Promise<Session[] | null>
    addPane(sourcePaneId: string, req: AddPaneReq): Promise<Session | null>
    createGroup(name: string, environment: number): Promise<Group | null>
    assignToGroup(paneId: string, groupId: string | null): Promise<Session | null>
    listGroups(): Promise<Group[]>
    listSessions(): Promise<Session[]>
    peekSession(id: string, maxLines?: number): Promise<string[]>
    grantOperator(environment: number): Promise<{ endpoint: string; token: string }>
  }
}

// --- IPC-direct helpers (window.localflow.*), mirroring the inline-evaluate
//     pattern every existing e2e spec uses (smoke.spec.ts:707,
//     operator.spec.ts, operator-launch.spec.ts) — just factored out since
//     this file calls several of them repeatedly across six tests. ---

function createSessionIpc(
  win: Page,
  agentId: string,
  cwd: string,
  environment = 1
): Promise<Session | null> {
  return win.evaluate(
    (args) =>
      (window as unknown as Api).localflow.createSession(
        args.agentId,
        args.cwd,
        undefined,
        args.environment
      ),
    { agentId, cwd, environment }
  )
}

function createTemplateIpc(
  win: Page,
  name: string,
  cwd: string,
  environment: number
): Promise<Session[] | null> {
  return win.evaluate(
    (args) =>
      (window as unknown as Api).localflow.createTemplate(args.name, args.cwd, args.environment),
    { name, cwd, environment }
  )
}

function addPaneIpc(win: Page, sourceId: string, req: AddPaneReq): Promise<Session | null> {
  return win.evaluate(
    (args) => (window as unknown as Api).localflow.addPane(args.sourceId, args.req),
    { sourceId, req }
  )
}

function listGroupsIpc(win: Page): Promise<Group[]> {
  return win.evaluate(() => (window as unknown as Api).localflow.listGroups())
}

function grantOperatorIpc(
  win: Page,
  environment: number
): Promise<{ endpoint: string; token: string }> {
  return win.evaluate((env) => (window as unknown as Api).localflow.grantOperator(env), environment)
}

test('template create: happy path, missing-binary skip, zero-pane rollback', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'localflow-e2e-'))
  const app = await launchApp(userData, {
    sessionTemplates: [
      // Happy path: two claude panes, both launchable (fake-claude.sh resolves).
      {
        name: 'pair',
        panes: [
          { kind: 'terminal', agentId: 'claude' },
          { kind: 'terminal', agentId: 'claude' }
        ]
      },
      // Missing-binary skip: codex has no resolved path (default /nonexistent
      // agentPaths from launchApp) — only the claude pane is launchable.
      {
        name: 'mixed',
        panes: [
          { kind: 'terminal', agentId: 'claude' },
          { kind: 'terminal', agentId: 'codex' }
        ]
      },
      // Zero-pane rollback: both agents unresolved — nothing launchable.
      {
        name: 'deadend',
        panes: [
          { kind: 'terminal', agentId: 'codex' },
          { kind: 'terminal', agentId: 'gemini' }
        ]
      }
    ]
  })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1400, height: 900 })
  await expect(win.locator('.new-session')).toBeVisible()

  try {
    // --- Happy path ---------------------------------------------------
    const pairPanes = await createTemplateIpc(win, 'pair', userData, 1)
    expect(pairPanes).not.toBeNull()
    expect(pairPanes!.length).toBe(2)
    expect(pairPanes![0].groupId).toBeDefined()
    expect(pairPanes![0].groupId).toBe(pairPanes![1].groupId)

    // Enter the environment grid via the sidebar nav item (not a session
    // row's "open", which auto-enlarges once more than one session exists —
    // there are two here already, and this assertion wants the plain grid)
    // to see the group render as a GroupBox: shared header + rollup dot,
    // both panes.
    await win.getByRole('button', { name: 'Environment', exact: true }).click()
    const groupBox = win.locator(
      `.group-box:has(.group-header[data-group-id="${pairPanes![0].groupId}"])`
    )
    await expect(groupBox).toBeVisible()
    await expect(groupBox.locator('.group-header')).toBeVisible()
    await expect(groupBox.locator('.group-rollup')).toHaveAttribute('data-status', 'idle')
    await expect(groupBox.locator('.pane')).toHaveCount(2)

    // --- Missing-binary skip -------------------------------------------
    const groupsBefore = await listGroupsIpc(win)
    const mixedPanes = await createTemplateIpc(win, 'mixed', userData, 1)
    expect(mixedPanes).not.toBeNull()
    expect(mixedPanes!.length).toBe(1) // only the claude pane launched
    expect(mixedPanes![0].agentId).toBe('claude')
    expect(mixedPanes![0].groupId).toBeDefined()

    const groupsAfterMixed = await listGroupsIpc(win)
    expect(groupsAfterMixed.length).toBe(groupsBefore.length + 1) // still grouped

    // --- Zero-pane rollback ---------------------------------------------
    const deadendResult = await createTemplateIpc(win, 'deadend', userData, 1)
    expect(deadendResult).toBeNull()
    const groupsAfterDeadend = await listGroupsIpc(win)
    // No group was persisted for the all-unlaunchable template — checked
    // both via the live IPC list and straight off sessions.json's `groups`
    // key (manager.onSessionsChanged's saveState runs synchronously within
    // the IPC call, so the file is already current by the time we get here).
    expect(groupsAfterDeadend.length).toBe(groupsAfterMixed.length)
    expect(readSavedGroups(userData).length).toBe(groupsAfterDeadend.length)
  } finally {
    await app.close()
  }
})

test('add-pane: cmd+t on a solo pane forms a group; GroupBox + also adds', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'localflow-e2e-'))
  const app = await launchApp(userData)
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1400, height: 900 })
  await expect(win.locator('.new-session')).toBeVisible()

  try {
    const a = await createSessionIpc(win, 'claude', userData, 1)
    await win.locator(`[data-session-id="${a!.id}"] .row-open`).click()
    const paneA = win.locator(`.pane[data-pane-id="${a!.id}"]`)
    await expect(paneA).toBeVisible()
    await expect(paneA).toHaveClass(/active/) // sole pane, opened active

    // --- Path 1: cmd+t (the add-pane keybinding) opens the picker on the
    //     active pane; picking an agent wraps the solo source into a fresh
    //     group and adds the companion into it. ---
    await win.keyboard.press('Meta+t')
    await expect(win.locator('.add-pane-picker')).toBeVisible()
    await win.locator('.pick-agent[data-agent-id="claude"]').click()
    await expect(win.locator('.add-pane-picker')).toHaveCount(0)

    const groupBox = win.locator('.group-box')
    await expect(groupBox).toBeVisible()
    await expect(groupBox.locator('.pane')).toHaveCount(2)

    // cwd inheritance, proven independently of our own model (the fake
    // agent's own startup line — "fake-claude started in $PWD with args"),
    // read via peekSession (main's rec.tail, filled unconditionally by
    // pty.onData) rather than off the mounted xterm's DOM: the companion's
    // very first output line can land before its TerminalPane has even
    // mounted and subscribed to the live onData push — a real race, not
    // just slow rendering — so scraping `.term-host` text is unreliable
    // here. peekSession is what the approve control's own peek uses for
    // exactly this reason.
    const groupIdAttr = await groupBox.locator('.group-header').getAttribute('data-group-id')
    const members = await win.evaluate(
      (groupId) =>
        (window as unknown as Api).localflow
          .listSessions()
          .then((all) => all.filter((s) => s.groupId === groupId)),
      groupIdAttr
    )
    expect(members.length).toBe(2)
    const companion = members.find((m) => m.id !== a!.id)!
    expect(companion.cwd).toBe(a!.cwd)
    await expect
      .poll(
        async () => {
          const lines = await win.evaluate(
            (id) => (window as unknown as Api).localflow.peekSession(id, 5),
            companion.id
          )
          return lines.join('\n')
        },
        { timeout: 10_000 }
      )
      .toContain(`started in ${a!.cwd}`)

    // --- Path 2: the GroupBox's own "+" button opens the same picker,
    //     targeting the group directly (Task 8's other entry point). ---
    await groupBox.locator('.group-add-pane').click()
    await expect(win.locator('.add-pane-picker')).toBeVisible()
    await win.locator('.pick-agent[data-agent-id="claude"]').click()
    await expect(win.locator('.add-pane-picker')).toHaveCount(0)
    await expect(groupBox.locator('.pane')).toHaveCount(3)
  } finally {
    await app.close()
  }
})

test('close-pane on a grouped pane moves focus to its sibling', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'localflow-e2e-'))
  const app = await launchApp(userData)
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1400, height: 900 })
  await expect(win.locator('.new-session')).toBeVisible()

  try {
    // Open the SOLO pane first (openSession only enlarges when more than
    // one session already exists — opening after the group is two sessions
    // deep would auto-enlarge A and complicate the "both visible" check
    // below for no reason), then form the group via addPane, which only
    // moves focus, never enlarge state.
    const a = await createSessionIpc(win, 'claude', userData, 1)
    await win.locator(`[data-session-id="${a!.id}"] .row-open`).click()
    const paneA = win.locator(`.pane[data-pane-id="${a!.id}"]`)
    await expect(paneA).toBeVisible()
    await expect(paneA).not.toHaveClass(/enlarged/)

    const b = await addPaneIpc(win, a!.id, { kind: 'terminal', agentId: 'claude' })
    expect(b!.groupId).toBeDefined() // addPane wraps the solo source into a fresh group
    const paneB = win.locator(`.pane[data-pane-id="${b!.id}"]`)
    await expect(paneB).toBeVisible()

    // Focus A explicitly (the cyan-ring `.pane.active` selector smoke.spec
    // already relies on), then close it via the keybinding.
    await paneA.click()
    await expect(paneA).toHaveClass(/active/)
    await win.keyboard.press('Meta+w')

    // Sibling-first focus: B (same group) gets the ring, not just "some
    // other pane" — nextFocusAfterClose's group-sibling preference.
    await expect(paneB).toHaveClass(/active/)
    await expect(paneA).not.toHaveClass(/active/)
    await expect(paneA).toHaveAttribute('data-status', 'exited')
  } finally {
    await app.close()
  }
})

test('enlarge staircase: pane -> session -> pane -> grid', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'localflow-e2e-'))
  const app = await launchApp(userData)
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1400, height: 900 })
  await expect(win.locator('.new-session')).toBeVisible()

  try {
    const a = await createSessionIpc(win, 'claude', userData, 1)
    await win.locator(`[data-session-id="${a!.id}"] .row-open`).click()
    const paneA = win.locator(`.pane[data-pane-id="${a!.id}"]`)
    await expect(paneA).toBeVisible()
    await expect(paneA).not.toHaveClass(/enlarged/) // solo pane, opened un-enlarged

    // cmd+t forms the group without disturbing enlarge/active state.
    await win.keyboard.press('Meta+t')
    await win.locator('.pick-agent[data-agent-id="claude"]').click()
    const groupBox = win.locator('.group-box')
    await expect(groupBox.locator('.pane')).toHaveCount(2)
    const groupId = await groupBox.locator('.group-header').getAttribute('data-group-id')
    const groups = await listGroupsIpc(win)
    const groupName = groups.find((g) => g.id === groupId)!.name

    await paneA.click()
    await expect(paneA).toHaveClass(/active/)

    // --- Level 1: cmd+m enlarges the active pane. Breadcrumb reads
    //     env › group › pane; the sibling strip lists both members. ---
    await win.keyboard.press('Meta+m')
    await expect(paneA).toHaveClass(/enlarged/)
    const breadcrumb = win.locator('.breadcrumb')
    await expect(breadcrumb).toContainText('1') // env label
    await expect(breadcrumb).toContainText(groupName) // session (group) level
    await expect(win.locator('.sibling-strip')).toBeVisible()
    await expect(win.locator('.sibling-strip .sibling-tab')).toHaveCount(2)

    // --- Level 2: cmd+m again -> session level, both panes visible side by
    //     side, no sibling strip (there's nothing left to switch to). ---
    await win.keyboard.press('Meta+m')
    await expect(win.locator('.group-enlarge-wrapper.enlarged')).toBeVisible()
    await expect(win.locator('.sibling-strip')).toHaveCount(0)
    await expect(win.locator('.group-enlarge-wrapper.enlarged .pane')).toHaveCount(2)
    for (const pane of await win.locator('.group-enlarge-wrapper.enlarged .pane').all()) {
      await expect(pane).toBeVisible()
    }

    // --- go-up once: session -> pane (back to the anchor, sibling strip
    //     returns). ---
    await win.keyboard.press('Meta+Escape')
    await expect(paneA).toHaveClass(/enlarged/)
    await expect(win.locator('.group-enlarge-wrapper.enlarged')).toHaveCount(0)
    await expect(win.locator('.sibling-strip')).toBeVisible()

    // --- go-up again: pane -> grid. Chrome is gone; the grouped grid
    //     (still both panes) is what's left. ---
    await win.keyboard.press('Meta+Escape')
    await expect(win.locator('.enlarge-chrome')).toHaveCount(0)
    await expect(paneA).not.toHaveClass(/enlarged/)
    await expect(groupBox.locator('.pane')).toHaveCount(2)
  } finally {
    await app.close()
  }
})

test('operator POST /panes: browser+groupId joins the group; foreign env is rejected', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'localflow-e2e-'))
  let server: ReturnType<typeof createServer> | undefined
  const app = await launchApp(userData)
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1400, height: 900 })
  await expect(win.locator('.new-session')).toBeVisible()

  try {
    // Real loadable local page (same convention as operator.spec's de-risk
    // note 3) — a browser pane's <webview> mounts at this src once the group
    // renders, so it must actually resolve rather than hang on a dead port.
    server = createServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html')
      res.end('<!doctype html><title>groups-fixture</title><h1>groups e2e fixture page</h1>')
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const pageUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`

    const a = await createSessionIpc(win, 'claude', userData, 1)
    const companion = await addPaneIpc(win, a!.id, { kind: 'terminal', agentId: 'claude' })
    const groupId = companion!.groupId!
    expect(groupId).toBeDefined()

    // Grant environment 1 (the group's own env) and environment 2 (the
    // isolation subject — same cross-env contract operator.spec covers for
    // panes, exercised here for the group-scoped POST /panes route).
    const grant1 = await grantOperatorIpc(win, 1)
    const grant2 = await grantOperatorIpc(win, 2)

    const post = (endpoint: string, token: string, body: unknown): Promise<Response> =>
      fetch(`${endpoint}/panes`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })

    // --- Same-env grant: browser + groupId creates the pane and joins the
    //     group. ---
    const okRes = await post(grant1.endpoint, grant1.token, {
      kind: 'browser',
      url: pageUrl,
      groupId
    })
    expect(okRes.status).toBe(200)
    const { pane } = (await okRes.json()) as { pane: { handle: string } }

    // Environment nav (not a session row's "open", which auto-enlarges once
    // more than one session exists — three do here) to see the plain grid.
    await win.getByRole('button', { name: 'Environment', exact: true }).click()
    const groupBox = win.locator(`.group-box:has(.group-header[data-group-id="${groupId}"])`)
    await expect(groupBox).toBeVisible()
    await expect
      .poll(async () => groupBox.locator(`.pane[data-pane-id="${pane.handle}"]`).count())
      .toBe(1)
    await expect(groupBox.locator('.pane')).toHaveCount(3)

    // --- Cross-env grant: environment 2's own token resolves to environment
    //     2, but the group belongs to environment 1 — rejected per the
    //     route's "unknown group" contract (control-api.ts), same wording
    //     whether the group is truly unknown or just foreign. ---
    const foreignRes = await post(grant2.endpoint, grant2.token, {
      kind: 'browser',
      url: pageUrl,
      groupId
    })
    expect(foreignRes.status).toBe(400)
  } finally {
    await app.close()
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
  }
})

test('resume dead-end: instant-exit resume shows Start fresh as primary', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'localflow-e2e-'))
  const app = await launchApp(userData, { resumeDeadArg: '--continue' })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1400, height: 900 })
  await expect(win.locator('.new-session')).toBeVisible()

  try {
    const a = await createSessionIpc(win, 'claude', userData, 1)
    await win.locator(`[data-session-id="${a!.id}"] .row-open`).click()
    const pane = win.locator(`.pane[data-pane-id="${a!.id}"]`)
    await expect(pane).toBeVisible()
    await expect(pane).toHaveAttribute('data-status', 'idle')

    // Close (not delete): the session stays listed as exited, offering
    // Resume/Start fresh — resumeFailed is not set yet (closedByUser exit).
    await pane.getByRole('button', { name: 'close' }).click()
    await expect(pane).toHaveAttribute('data-status', 'exited')
    await expect(pane.getByRole('button', { name: 'Start fresh' })).toBeVisible()

    // Resume: fake-claude.sh sees --continue (claude's resumeArgs) plus
    // LOCALFLOW_E2E_RESUME_DEAD_ARG and exits immediately — instant enough
    // to land inside SessionManager's INSTANT_EXIT_MS window, flipping
    // resumeFailed.
    await pane.getByRole('button', { name: 'Resume conversation' }).click()
    await expect(pane).toHaveAttribute('data-status', 'exited', { timeout: 10_000 })

    // The dead-end overlay demotes "Resume conversation" and leads with
    // "Start fresh" as the primary action — assert both are present, and
    // that Start fresh now renders first (DOM order = the resumeFailed
    // branch, per TerminalPane.tsx).
    const overlay = pane.locator('.restart-overlay')
    await expect(overlay).toContainText('Resume failed instantly')
    const buttons = overlay.locator('button')
    await expect(buttons).toHaveCount(2)
    await expect(buttons.nth(0)).toHaveText('Start fresh')
    await expect(buttons.nth(1)).toHaveText('Resume conversation')
  } finally {
    await app.close()
  }
})
