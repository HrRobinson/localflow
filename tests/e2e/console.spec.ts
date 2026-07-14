import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Same launch shape as smoke.spec.ts's launchApp: per-test userData dir,
 * config.json pre-seeded with nonexistent codex/gemini paths (so agent
 * detection short-circuits), fake-claude as the terminal binary. Merges
 * rather than overwrites config.json so a relaunch against the same userData
 * (every persistence assertion below) doesn't clobber what was saved.
 */
function launchApp(userData: string): Promise<ElectronApplication> {
  const configFile = join(userData, 'config.json')
  const existing: Record<string, unknown> = existsSync(configFile)
    ? JSON.parse(readFileSync(configFile, 'utf8'))
    : {}
  writeFileSync(
    configFile,
    JSON.stringify({
      ...existing,
      agentPaths: {
        codex: '/nonexistent/codex',
        gemini: '/nonexistent/gemini',
        ...((existing.agentPaths as Record<string, string>) ?? {})
      }
    })
  )
  return electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      LOCALFLOW_E2E: '1',
      LOCALFLOW_USER_DATA: userData,
      LOCALFLOW_CLAUDE_BIN: join(here, '../fixtures/fake-claude.sh'),
      LOCALFLOW_OPENCLAW_CONFIG: join(userData, 'openclaw.json'),
      LOCALFLOW_LAZYGIT_BIN: '/nonexistent/lazygit',
      LOCALFLOW_EDITOR_BIN: '/nonexistent/code',
      LOCALFLOW_E2E_GO: join(userData, 'e2e-go')
    }
  })
}

interface Session {
  id: string
  environment: number
}

/** Renderer-side `window.localflow` surface this spec calls through IPC. */
type Api = {
  localflow: {
    createSession(
      agentId: string,
      cwd?: string,
      customCommand?: string,
      environment?: number
    ): Promise<Session | null>
    grantOperator(environment: number): Promise<{ endpoint: string; token: string }>
    registerWatchpoint(
      environment: number,
      workflow: string,
      step: string,
      capture: string[]
    ): Promise<{ id: string } | null>
  }
}

function createSessionIpc(win: Page, cwd: string, environment = 1): Promise<Session | null> {
  return win.evaluate(
    (args) =>
      (window as unknown as Api).localflow.createSession(
        'claude',
        args.cwd,
        undefined,
        args.environment
      ),
    { cwd, environment }
  )
}

function grantOperatorIpc(
  win: Page,
  environment: number
): Promise<{ endpoint: string; token: string }> {
  return win.evaluate((env) => (window as unknown as Api).localflow.grantOperator(env), environment)
}

function registerWatchpointIpc(
  win: Page,
  environment: number,
  workflow: string,
  step: string,
  capture: string[]
): Promise<{ id: string } | null> {
  return win.evaluate(
    (args) =>
      (window as unknown as Api).localflow.registerWatchpoint(
        args.environment,
        args.workflow,
        args.step,
        args.capture
      ),
    { environment, workflow, step, capture }
  )
}

/** Post a hook event through the same endpoint.json handshake smoke.spec.ts uses. */
function postHook(userData: string, paneId: string, event: string): Promise<Response> {
  const { port, token } = JSON.parse(readFileSync(join(userData, 'endpoint.json'), 'utf8'))
  return fetch(`http://127.0.0.1:${port}/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Localflow-Token': token },
    body: JSON.stringify({ paneId, event })
  })
}

/** A scripted control-API client bound to one operator grant (endpoint + bearer token). */
function controlClient(endpoint: string, token: string) {
  const call = (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${endpoint}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  return { call }
}

test('toggle drawer: cmd+/ default, then a remapped key survives relaunch', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'localflow-e2e-'))
  const app = await launchApp(userData)
  const win = await app.firstWindow()
  await expect(win.locator('.new-session')).toBeVisible()

  // Closed by default; cmd+/ opens, cmd+/ again closes.
  await expect(win.locator('[data-console]')).toHaveCount(0)
  await win.keyboard.press('Meta+/')
  await expect(win.locator('[data-console]')).toBeVisible()
  await win.keyboard.press('Meta+/')
  await expect(win.locator('[data-console]')).toHaveCount(0)

  await app.close()

  // Rebind console-toggle to cmd+y directly on disk (mirrors Settings' live
  // rebind flow, which smoke.spec.ts already covers for a different action)
  // and relaunch against the same userData.
  writeFileSync(join(userData, 'keybindings.json'), JSON.stringify({ 'console-toggle': 'cmd+y' }))
  const app2 = await launchApp(userData)
  const win2 = await app2.firstWindow()
  await expect(win2.locator('.new-session')).toBeVisible()

  // The old combo is dead; the new one works.
  await win2.keyboard.press('Meta+/')
  await expect(win2.locator('[data-console]')).toHaveCount(0)
  await win2.keyboard.press('Meta+y')
  await expect(win2.locator('[data-console]')).toBeVisible()
  await win2.keyboard.press('Meta+y')
  await expect(win2.locator('[data-console]')).toHaveCount(0)

  await app2.close()
})

test('three sources appear: status, operator, capture — capture expands to detail', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'localflow-e2e-'))
  const app = await launchApp(userData)
  const win = await app.firstWindow()
  await expect(win.locator('.new-session')).toBeVisible()

  const session = await createSessionIpc(win, userData)
  expect(session).not.toBeNull()

  await win.keyboard.press('Meta+/')
  const drawer = win.locator('[data-console]')
  await expect(drawer).toBeVisible()

  // 1. Status source: drive a hook event on the created session's pane.
  await postHook(userData, session!.id, 'UserPromptSubmit')
  const statusRow = drawer.locator('[data-console-row][data-source="status"]', {
    hasText: 'UserPromptSubmit'
  })
  await expect(statusRow).toBeVisible()

  // 2. Operator source: grant the operator and drive a real control-API
  // action (POST prompt) against the session's pane.
  const grant = await grantOperatorIpc(win, session!.environment)
  const client = controlClient(grant.endpoint, grant.token)
  const promptRes = await client.call('POST', `/panes/${session!.id}/prompt`, { text: 'hello-op' })
  expect(promptRes.status).toBe(200)
  const operatorRow = drawer.locator('[data-console-row][data-source="operator"]', {
    hasText: 'hello-op'
  })
  await expect(operatorRow).toBeVisible()

  // 3. Capture source: register a watchpoint, then ingest a capture for it
  // over the control API (the same route OpenClaw's checkpoint action hits).
  const wp = await registerWatchpointIpc(win, session!.environment, 'demo-workflow', 'demo-step', [
    'output'
  ])
  expect(wp).not.toBeNull()
  const captureRes = await client.call('POST', '/captures', {
    watchpointId: wp!.id,
    output: ['capture-output-marker'],
    halted: false
  })
  expect(captureRes.status).toBe(201)
  const captureRow = drawer.locator('[data-console-row][data-source="capture"]', {
    hasText: wp!.id
  })
  await expect(captureRow).toBeVisible()

  // Clicking the capture row expands it in place to its detail, including
  // the captured output — no navigation away.
  await expect(captureRow.locator('[data-console-detail]')).toHaveCount(0)
  await captureRow.click()
  const detail = captureRow.locator('[data-console-detail]')
  await expect(detail).toBeVisible()
  await expect(detail).toContainText('capture-output-marker')

  await app.close()
})

test('filters: source chips, text substring, everywhere scope pin', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'localflow-e2e-'))
  const app = await launchApp(userData)
  const win = await app.firstWindow()
  await expect(win.locator('.new-session')).toBeVisible()

  const session = await createSessionIpc(win, userData)
  await postHook(userData, session!.id, 'UserPromptSubmit')

  const grant = await grantOperatorIpc(win, session!.environment)
  const client = controlClient(grant.endpoint, grant.token)
  await client.call('POST', `/panes/${session!.id}/prompt`, { text: 'filter-op-marker' })

  const wp = await registerWatchpointIpc(win, session!.environment, 'demo-workflow', 'demo-step', [
    'output'
  ])
  await client.call('POST', '/captures', {
    watchpointId: wp!.id,
    output: ['filter-capture-marker'],
    halted: false
  })

  await win.keyboard.press('Meta+/')
  const drawer = win.locator('[data-console]')
  await expect(drawer).toBeVisible()

  const allRows = drawer.locator('[data-console-row]')
  const statusRows = drawer.locator('[data-console-row][data-source="status"]')
  const operatorRows = drawer.locator('[data-console-row][data-source="operator"]')
  const captureRows = drawer.locator('[data-console-row][data-source="capture"]')

  // Baseline: every source represented before any filter is applied.
  await expect(statusRows).not.toHaveCount(0)
  await expect(operatorRows).not.toHaveCount(0)
  await expect(captureRows).not.toHaveCount(0)
  const totalCount = await allRows.count()

  // Source chip: clicking "status" narrows to status-only rows.
  await drawer.locator('[data-console-source="status"]').click()
  await expect(allRows).toHaveCount(await statusRows.count())
  await expect(operatorRows).toHaveCount(0)
  await expect(captureRows).toHaveCount(0)

  // Clicking the same chip again returns to "all sources".
  await drawer.locator('[data-console-source="status"]').click()
  await expect(allRows).toHaveCount(totalCount)

  // Source chip: "operator" narrows to operator-only rows.
  await drawer.locator('[data-console-source="operator"]').click()
  await expect(allRows).toHaveCount(await operatorRows.count())
  await expect(statusRows).toHaveCount(0)
  await drawer.locator('[data-console-source="operator"]').click()
  await expect(allRows).toHaveCount(totalCount)

  // Text filter: a substring unique to the operator row narrows to exactly it.
  await drawer.locator('[data-console-text]').fill('filter-op-marker')
  await expect(allRows).toHaveCount(1)
  await expect(allRows.first()).toHaveAttribute('data-source', 'operator')
  await drawer.locator('[data-console-text]').fill('')
  await expect(allRows).toHaveCount(totalCount)

  // Scope: pinning "everywhere" keeps the full pinned set (and shows "follow",
  // proving the pin took effect over the auto-derived scope).
  await expect(drawer.locator('[data-console-follow]')).toHaveCount(0)
  await drawer.locator('[data-console-scope="everywhere"]').click()
  await expect(drawer.locator('[data-console-follow]')).toBeVisible()
  await expect(allRows).toHaveCount(totalCount)

  await app.close()
})

test('scope follow + pin: enlarging a session narrows the timeline; pin sticks; follow resumes', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'localflow-e2e-'))
  const app = await launchApp(userData)
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1400, height: 900 })
  await expect(win.locator('.new-session')).toBeVisible()

  const a = await createSessionIpc(win, userData)
  const b = await createSessionIpc(win, userData)
  await expect(win.locator(`[data-session-id="${b!.id}"]`)).toBeVisible()

  // Distinct hook-driven labels so a and b's status rows are distinguishable
  // by their rendered text alone (rows carry no session-id attribute).
  await postHook(userData, a!.id, 'UserPromptSubmit') // label: "UserPromptSubmit · working"
  await postHook(userData, b!.id, 'Notification') // label: "Notification · needs-you"

  await win.keyboard.press('Meta+/')
  const drawer = win.locator('[data-console]')
  await expect(drawer).toBeVisible()
  const rowA = drawer.locator('[data-console-row]', { hasText: 'UserPromptSubmit' })
  const rowB = drawer.locator('[data-console-row]', { hasText: 'Notification' })

  // Home view: auto scope resolves to "everywhere" — both visible.
  await expect(rowA).toBeVisible()
  await expect(rowB).toBeVisible()

  // Open session a from the Overview row: with 2 sessions this auto-enlarges
  // it, so auto scope narrows to { session: a }.
  await win.locator(`[data-session-id="${a!.id}"]`).locator('.row-open').click()
  const paneA = win.locator(`[data-pane-id="${a!.id}"]`)
  await expect(paneA).toHaveClass(/enlarged/)
  await expect(rowA).toBeVisible()
  await expect(rowB).toHaveCount(0)

  // Pin "everywhere": the wider set stays even though a is still enlarged.
  await drawer.locator('[data-console-scope="everywhere"]').click()
  await expect(rowA).toBeVisible()
  await expect(rowB).toBeVisible()

  // Navigate to b (sidebar): with the pin held, both rows must still show —
  // scope-follow-location would otherwise have narrowed to b only.
  await win.locator(`[data-nav-session="${b!.id}"] button`).first().click()
  const paneB = win.locator(`[data-pane-id="${b!.id}"]`)
  await expect(paneB).toHaveClass(/enlarged/)
  await expect(rowA).toBeVisible()
  await expect(rowB).toBeVisible()

  // Clear the pin via "follow": auto resumes, narrowing to wherever we now
  // are (enlarged on b) — a's row drops out, b's stays.
  await drawer.locator('[data-console-follow]').click()
  await expect(rowB).toBeVisible()
  await expect(rowA).toHaveCount(0)

  await app.close()
})

test('resize + relaunch: height and open state are remembered', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'localflow-e2e-'))
  const app = await launchApp(userData)
  const win = await app.firstWindow()
  await expect(win.locator('.new-session')).toBeVisible()

  await win.keyboard.press('Meta+/')
  const drawer = win.locator('[data-console]')
  await expect(drawer).toBeVisible()

  const startHeight = await drawer.evaluate((el) => el.getBoundingClientRect().height)

  // Drag the top-edge resize handle upward by 80px, which grows the drawer
  // by the same amount (Console.tsx: dragging up shrinks clientY, and
  // next = startHeight + (startY - clientY)).
  const handle = win.locator('[data-console-resize]')
  const box = await handle.boundingBox()
  if (!box) throw new Error('resize handle has no layout box')
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  await win.mouse.move(cx, cy)
  await win.mouse.down()
  await win.mouse.move(cx, cy - 80, { steps: 10 })
  await win.mouse.up()

  const expectedHeight = startHeight + 80
  await expect
    .poll(() => drawer.evaluate((el) => el.getBoundingClientRect().height))
    .toBe(expectedHeight)

  // Prefs persist debounced (300ms) — poll the on-disk config rather than a
  // fixed sleep.
  const configFile = join(userData, 'config.json')
  await expect
    .poll(() => {
      const config = JSON.parse(readFileSync(configFile, 'utf8'))
      return config.console?.height
    })
    .toBe(expectedHeight)
  expect(JSON.parse(readFileSync(configFile, 'utf8')).console?.open).toBe(true)

  await app.close()

  // Relaunch against the same userData: the drawer reopens at the persisted
  // height without pressing the toggle key.
  const app2 = await launchApp(userData)
  const win2 = await app2.firstWindow()
  await expect(win2.locator('.new-session')).toBeVisible()
  const drawer2 = win2.locator('[data-console]')
  await expect(drawer2).toBeVisible()
  await expect
    .poll(() => drawer2.evaluate((el) => el.getBoundingClientRect().height))
    .toBe(expectedHeight)

  const configAfterRelaunch = JSON.parse(readFileSync(configFile, 'utf8'))
  expect(configAfterRelaunch.console?.height).toBe(expectedHeight)
  expect(configAfterRelaunch.console?.open).toBe(true)

  await app2.close()
})
