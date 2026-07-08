import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Launch the app against a userData dir. Pre-seeds/merges config.json with
 * absolute paths for codex/gemini — nonexistent by default so their
 * detection short-circuits through existsSync instead of racing a real
 * (slow) login-shell `command -v` lookup against expect()'s timeouts; pass
 * `agentPaths` to point either (or both) at a real fixture script instead,
 * e.g. the fake-codex.sh/fake-gemini.sh pair. Merges rather than overwrites
 * so a relaunch against the same userData (e.g. to check lastAgent
 * persistence) doesn't clobber what was saved.
 */
function launchApp(
  userData: string,
  agentPaths: Record<string, string> = {}
): Promise<ElectronApplication> {
  const configFile = join(userData, 'config.json')
  const existing: { agentPaths?: Record<string, string> } = existsSync(configFile)
    ? JSON.parse(readFileSync(configFile, 'utf8'))
    : {}
  writeFileSync(
    configFile,
    JSON.stringify({
      ...existing,
      agentPaths: {
        codex: '/nonexistent/codex',
        gemini: '/nonexistent/gemini',
        ...existing.agentPaths,
        ...agentPaths
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
      // Marker file the codex/gemini fixtures poll for before firing their
      // hook commands (SessionManager.spawn passes the app's env through to
      // every pty): a test creates it via goMarker() only once everything
      // that must precede the fixture's events has been asserted, making
      // the status order deterministic by construction instead of
      // sleep-raced. Fixtures that never fire hooks (fake-claude.sh)
      // simply ignore it.
      LOCALFLOW_E2E_GO: join(userData, 'e2e-go')
    }
  })
}

/** Release a launched app's hook-firing fixtures (see LOCALFLOW_E2E_GO). */
function goMarker(userData: string): void {
  writeFileSync(join(userData, 'e2e-go'), '')
}

test('panes render and hook events change status colors', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'localflow-e2e-'))
  const app = await launchApp(userData)
  const win = await app.firstWindow()
  await expect(win.locator('.new-session')).toBeVisible()

  const info = await win.evaluate(
    (cwd) =>
      (
        window as unknown as {
          localflow: { createSession(a: string, c: string): Promise<{ id: string }> }
        }
      ).localflow.createSession('claude', cwd),
    userData
  )
  // The app opens on the home overview: the created session appears as a
  // table row, and clicking "open" enters the terminal grid.
  const row = win.locator(`[data-session-id="${info!.id}"]`)
  await expect(row).toBeVisible()
  await row.locator('.row-open').click()

  const pane = win.locator(`[data-pane-id="${info!.id}"]`)
  await expect(pane).toBeVisible()
  await expect(pane).toHaveAttribute('data-status', 'idle')

  const { port, token } = JSON.parse(readFileSync(join(userData, 'endpoint.json'), 'utf8'))
  const post = (event: string): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Localflow-Token': token },
      body: JSON.stringify({ paneId: info!.id, event })
    })

  await post('UserPromptSubmit')
  await expect(pane).toHaveAttribute('data-status', 'working')
  await post('Notification')
  await expect(pane).toHaveAttribute('data-status', 'needs-you')
  await post('Stop')
  await expect(pane).toHaveAttribute('data-status', 'idle')

  await app.close()
})

test('codex pane (notify tier): fixture-executed Stop hook reaches idle', async () => {
  // fake-codex.sh doesn't parse Codex's real -c grammar — it extracts and
  // runs the exact curl command localflow's cli-args-notify adapter
  // embedded (see src/main/codex-hooks.ts), proving localflow's own wiring
  // end-to-end. It is not proof the real `codex` binary invokes -c the
  // same way — see the manual verification checklist in
  // docs/superpowers/plans/2026-07-07-m2-status-adapters.md.
  const userData = mkdtempSync(join(tmpdir(), 'localflow-e2e-'))
  const app = await launchApp(userData, { codex: join(here, '../fixtures/fake-codex.sh') })
  const win = await app.firstWindow()
  await expect(win.locator('.new-session')).toBeVisible()

  const info = await win.evaluate(
    (cwd) =>
      (
        window as unknown as {
          localflow: { createSession(a: string, c: string): Promise<{ id: string }> }
        }
      ).localflow.createSession('codex', cwd),
    userData
  )
  const row = win.locator(`[data-session-id="${info!.id}"]`)
  await expect(row).toBeVisible()
  await row.locator('.row-open').click()

  const pane = win.locator(`[data-pane-id="${info!.id}"]`)
  await expect(pane).toBeVisible()
  // Codex has a hook adapter, so the initial status is 'idle', same as
  // Claude — never the violet 'running' fallback custom sessions get.
  await expect(pane).toHaveAttribute('data-status', 'idle')

  // Manually drive a 'working' state via the same hook-server endpoint the
  // claude test uses, to prove the subsequent idle transition below is a
  // real state change coming from the fixture's own executed hook command,
  // not just the untouched initial default.
  const { port, token } = JSON.parse(readFileSync(join(userData, 'endpoint.json'), 'utf8'))
  await fetch(`http://127.0.0.1:${port}/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Localflow-Token': token },
    body: JSON.stringify({ paneId: info!.id, event: 'UserPromptSubmit' })
  })
  await expect(pane).toHaveAttribute('data-status', 'working')
  expect(await pane.getAttribute('data-status')).not.toBe('running')

  // Only now release the fixture: it has been polling for the go-marker
  // since spawn, so its Stop-mapped hook cannot have fired before the
  // 'working' assertion above — the idle below is guaranteed to be the
  // fixture's own executed curl, proving localflow's -c injection reaches
  // a real child process and executes, with no sleep-length race.
  goMarker(userData)
  await expect(pane).toHaveAttribute('data-status', 'idle')
  expect(await pane.getAttribute('data-status')).not.toBe('running')

  await app.close()
})

test('gemini pane (env tier): fixture cycles working -> needs-you -> idle', async () => {
  // fake-gemini.sh doesn't parse Gemini's real settings consumption — it
  // reads the file localflow pointed GEMINI_CLI_SYSTEM_SETTINGS_PATH at
  // (see src/main/gemini-hooks.ts) and runs each hook's command itself,
  // including piping a fake {"type":"ToolPermission"} payload into the
  // Notification hook to exercise the payload-gated branch. Not proof the
  // real `gemini` binary uses this settings shape or payload field name —
  // see the manual verification checklist in
  // docs/superpowers/plans/2026-07-07-m2-status-adapters.md.
  const userData = mkdtempSync(join(tmpdir(), 'localflow-e2e-'))
  const app = await launchApp(userData, { gemini: join(here, '../fixtures/fake-gemini.sh') })
  const win = await app.firstWindow()
  await expect(win.locator('.new-session')).toBeVisible()

  const info = await win.evaluate(
    (cwd) =>
      (
        window as unknown as {
          localflow: { createSession(a: string, c: string): Promise<{ id: string }> }
        }
      ).localflow.createSession('gemini', cwd),
    userData
  )
  const row = win.locator(`[data-session-id="${info!.id}"]`)
  await expect(row).toBeVisible()
  await row.locator('.row-open').click()

  const pane = win.locator(`[data-pane-id="${info!.id}"]`)
  await expect(pane).toBeVisible()
  await expect(pane).toHaveAttribute('data-status', 'idle')

  // Release the fixture (it polls for the go-marker since spawn, so
  // nothing fired before the initial-idle assertion above), then observe
  // BeforeAgent -> Notification(ToolPermission) -> AfterAgent, self-paced
  // 1s apart by the fixture — the three assertions below are driven purely
  // by the fixture actually executing localflow's injected commands, no
  // manual fetch() POSTs involved.
  goMarker(userData)
  await expect(pane).toHaveAttribute('data-status', 'working')
  await expect(pane).toHaveAttribute('data-status', 'needs-you')
  await expect(pane).toHaveAttribute('data-status', 'idle')

  await app.close()
})

test('keyboard nav: focus moves, enlarge toggle, bare keys fall through', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'localflow-e2e-'))
  const app = await launchApp(userData)
  const win = await app.firstWindow()
  // Two panes must land side by side (auto-fit columns, min 460px) for
  // Meta+l/Meta+h to be an unambiguous left/right pair — the default
  // viewport isn't guaranteed to be wide enough.
  await win.setViewportSize({ width: 1400, height: 900 })
  await expect(win.locator('.new-session')).toBeVisible()

  const createSession = (cwd: string): Promise<{ id: string } | null> =>
    win.evaluate(
      (dir) =>
        (
          window as unknown as {
            localflow: { createSession(a: string, c: string): Promise<{ id: string } | null> }
          }
        ).localflow.createSession('claude', dir),
      cwd
    )

  // Create and open the first session while it's the only one, so opening
  // it doesn't trigger the "open with 2+ sessions" auto-enlarge — we want
  // to start from a plain, unenlarged environment view for the nav assertions.
  const first = await createSession(userData)
  const firstRow = win.locator(`[data-session-id="${first!.id}"]`)
  await expect(firstRow).toBeVisible()
  await firstRow.locator('.row-open').click()

  const firstPane = win.locator(`[data-pane-id="${first!.id}"]`)
  await expect(firstPane).toBeVisible()
  await expect(firstPane).toHaveClass(/active/)

  // Now bring in a second session while already in the environment view.
  const second = await createSession(userData)
  const secondPane = win.locator(`[data-pane-id="${second!.id}"]`)
  await expect(secondPane).toBeVisible()

  await expect(win.locator('.pane.active')).toHaveCount(1)
  await expect(firstPane).toHaveClass(/active/)
  await expect(secondPane).not.toHaveClass(/active/)

  // first pane was created first, so it renders in the left grid column;
  // Meta+l is bound to focus-right, moving focus to the second pane.
  await win.keyboard.press('Meta+l')
  await expect(secondPane).toHaveClass(/active/)
  await expect(firstPane).not.toHaveClass(/active/)
  await expect(win.locator('.pane.active')).toHaveCount(1)

  // Meta+h is bound to focus-left, moving focus back to the first pane.
  await win.keyboard.press('Meta+h')
  await expect(firstPane).toHaveClass(/active/)
  await expect(secondPane).not.toHaveClass(/active/)
  await expect(win.locator('.pane.active')).toHaveCount(1)

  // Meta+m toggles enlarge on the active (first) pane.
  await win.keyboard.press('Meta+m')
  await expect(firstPane).toHaveClass(/enlarged/)
  await win.keyboard.press('Meta+m')
  await expect(firstPane).not.toHaveClass(/enlarged/)

  // Bare keys must fall through to the terminal untouched: typing a
  // character must not throw, change view, or move focus off the active
  // pane — the capture-phase dispatcher only claims bound combos.
  await win.keyboard.type('x')
  await expect(win.locator('.pane.active')).toHaveCount(1)
  await expect(firstPane).toHaveClass(/active/)

  await app.close()
})

test('Settings nav, unresolved-agent disabling, lastAgent persists restart', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'localflow-e2e-'))

  const app = await launchApp(userData)
  const win = await app.firstWindow()
  await expect(win.locator('.new-session')).toHaveCount(1)

  // Settings nav item leaves the session-creation UI entirely.
  await win.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(win.getByText('Agents', { exact: true })).toBeVisible()
  await expect(win.locator('.new-session')).toHaveCount(0)

  // Back to Overview: the agent select gates .new-session on resolution.
  await win.getByRole('button', { name: 'Overview', exact: true }).click()
  const select = win.locator('.landing select')
  await expect(select).toHaveValue('claude')
  await expect(win.locator('.new-session')).toBeEnabled()

  // codex is pre-seeded with a nonexistent absolute path in config.json, so
  // it resolves to nothing and the "Configure in Settings" hint takes over
  // new-session creation.
  await select.selectOption('codex')
  await expect(win.locator('.new-session')).toBeDisabled()
  await expect(win.getByText('Configure in Settings')).toBeVisible()

  await select.selectOption('claude')
  await expect(win.locator('.new-session')).toBeEnabled()
  await expect(win.getByText('Configure in Settings')).not.toBeVisible()

  // Create a session directly via the API (bypassing the folder picker, as
  // the other tests do) with a custom agent/command — custom works
  // headlessly and doesn't need the fake-claude binary. `cat` (rather than
  // a real shell like zsh/bash) is deliberate: a real login shell sources
  // the user's dotfiles, which can spawn detached background jobs that
  // outlive the shell and hold the pty open, hanging Electron's shutdown
  // on app.close() below — reproduced locally, so keep this inert.
  const created = await win.evaluate(
    (cwd) =>
      (
        window as unknown as {
          localflow: {
            createSession(a: string, c: string, cmd: string): Promise<{ id: string } | null>
          }
        }
      ).localflow.createSession('custom', cwd, 'cat'),
    userData
  )
  expect(created).not.toBeNull()

  await app.close()

  // Relaunch against the SAME userData dir and confirm lastAgent survived
  // a real restart, not just in-memory state.
  const app2 = await launchApp(userData)
  const win2 = await app2.firstWindow()

  const lastAgent = await win2.evaluate(() =>
    (
      window as unknown as {
        localflow: { getLastAgent(): Promise<{ agentId: string; customCommand?: string } | null> }
      }
    ).localflow.getLastAgent()
  )
  expect(lastAgent).toEqual({ agentId: 'custom', customCommand: 'cat' })

  // The Overview select preselects the persisted custom command too.
  const select2 = win2.locator('.landing select')
  await expect(select2).toHaveValue('custom')
  await expect(win2.locator('.landing input[placeholder="e.g. aider"]')).toHaveValue('cat')

  // The config file itself is the contract — assert its on-disk shape too.
  const config = JSON.parse(readFileSync(join(userData, 'config.json'), 'utf8'))
  expect(config.lastAgent).toEqual({ agentId: 'custom', customCommand: 'cat' })

  await app2.close()
})

test('closing a terminal keeps the session listed; delete is confirm-gated', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'localflow-e2e-'))
  const app = await launchApp(userData)
  const win = await app.firstWindow()
  await expect(win.locator('.new-session')).toBeVisible()

  const info = await win.evaluate(
    (cwd) =>
      (
        window as unknown as {
          localflow: { createSession(a: string, c: string): Promise<{ id: string }> }
        }
      ).localflow.createSession('claude', cwd),
    userData
  )
  const row = win.locator(`[data-session-id="${info!.id}"]`)
  await expect(row).toBeVisible()
  await row.locator('.row-open').click()

  const pane = win.locator(`[data-pane-id="${info!.id}"]`)
  await expect(pane).toBeVisible()
  await expect(pane).toHaveAttribute('data-status', 'idle')

  // Close just this pane's pty (the pane header's "close" button, wired to
  // closeTerminal — not deleteSession). The session must stay listed as
  // exited, resumable, and with none of the "instant exit" crash messaging
  // that a real agent crash would show (this close was user-initiated).
  await pane.getByRole('button', { name: 'close', exact: true }).click()
  await expect(pane).toHaveAttribute('data-status', 'exited')
  await expect(pane.getByRole('button', { name: 'Resume conversation' })).toBeVisible()
  await expect(pane.getByRole('button', { name: 'Start fresh' })).toBeVisible()
  await expect(pane.locator('.restart-overlay p')).toHaveCount(0)

  // A second session keeps sessions.length > 0 after the delete below, so
  // the environment grid actually mounts for the final pane-absence check —
  // asserting toHaveCount(0) with the grid unmounted would be vacuous.
  const second = await win.evaluate(
    (cwd) =>
      (
        window as unknown as {
          localflow: { createSession(a: string, c: string): Promise<{ id: string }> }
        }
      ).localflow.createSession('claude', cwd),
    userData
  )
  const secondPane = win.locator(`[data-pane-id="${second!.id}"]`)
  await expect(secondPane).toBeVisible()

  // Overview: the row is still there, now offering resume/fresh instead of
  // "open" — closeTerminal must not have deleted the session record.
  await win.getByRole('button', { name: 'Overview', exact: true }).click()
  await expect(row).toBeVisible()
  await expect(row.getByRole('button', { name: 'resume', exact: true })).toBeVisible()
  await expect(row.getByRole('button', { name: 'fresh', exact: true })).toBeVisible()
  await expect(row.locator('.row-open')).toHaveCount(0)

  // Arming delete (the row's "×") must not delete on the first click.
  await row.locator('button[title="Delete session"]').click()
  await expect(row.getByRole('button', { name: 'Delete', exact: true })).toBeVisible()
  await expect(row.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
  await expect(row).toBeVisible()

  // Cancel disarms without deleting.
  await row.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(row.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0)
  await expect(row).toBeVisible()

  // Arm again and confirm: now the row is gone for good.
  await row.locator('button[title="Delete session"]').click()
  await row.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(row).toHaveCount(0)

  // Back to Environment via the sidebar: with the second session keeping the
  // grid mounted, exactly the deleted pane is gone and the survivor renders
  // — proving the delete removed the right session, not that the grid was
  // simply unmounted.
  await win.getByRole('button', { name: 'Environment', exact: true }).click()
  await expect(secondPane).toBeVisible()
  await expect(win.locator(`[data-pane-id="${info!.id}"]`)).toHaveCount(0)

  await app.close()
})

test('rename via the pencil icon persists across a relaunch', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'localflow-e2e-'))
  const app = await launchApp(userData)
  const win = await app.firstWindow()
  await expect(win.locator('.new-session')).toBeVisible()

  const info = await win.evaluate(
    (cwd) =>
      (
        window as unknown as {
          localflow: { createSession(a: string, c: string): Promise<{ id: string }> }
        }
      ).localflow.createSession('claude', cwd),
    userData
  )
  const row = win.locator(`[data-session-id="${info!.id}"]`)
  await expect(row).toBeVisible()

  // Default name is the cwd's folder basename (createSession was passed
  // userData itself as cwd, matching session-manager's basename(cwd) default).
  const defaultName = basename(userData)
  await expect(row.locator('strong')).toHaveText(defaultName)

  // Rename via the hover pencil (not double-click) → Enter saves.
  await row.locator('button[title="Rename session"]').click()
  const input = row.locator('input')
  await expect(input).toBeVisible()
  await input.fill('Renamed Session')
  await input.press('Enter')
  await expect(row.locator('strong')).toHaveText('Renamed Session')

  // The sidebar's matching entry reflects the same rename.
  const navEntry = win.locator(`[data-nav-session="${info!.id}"]`)
  await expect(navEntry).toContainText('Renamed Session')

  await app.close()

  // Relaunch against the SAME userData dir: the name must have been
  // persisted to sessions.json, not just held in React state.
  const app2 = await launchApp(userData)
  const win2 = await app2.firstWindow()
  const row2 = win2.locator(`[data-session-id="${info!.id}"]`)
  await expect(row2).toBeVisible()
  await expect(row2.locator('strong')).toHaveText('Renamed Session')

  const saved = JSON.parse(readFileSync(join(userData, 'sessions.json'), 'utf8')) as Array<{
    id: string
    name?: string
  }>
  expect(saved.find((s) => s.id === info!.id)?.name).toBe('Renamed Session')

  await app2.close()
})

test('approve: peek-gated Enter from overview row and pane header', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'localflow-e2e-'))
  const app = await launchApp(userData)
  const win = await app.firstWindow()
  await expect(win.locator('.new-session')).toBeVisible()

  const info = await win.evaluate(
    (cwd) =>
      (
        window as unknown as {
          localflow: { createSession(a: string, c: string): Promise<{ id: string }> }
        }
      ).localflow.createSession('claude', cwd),
    userData
  )
  const row = win.locator(`[data-session-id="${info!.id}"]`)
  await expect(row).toBeVisible()

  const { port, token } = JSON.parse(readFileSync(join(userData, 'endpoint.json'), 'utf8'))
  const post = (event: string): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Localflow-Token': token },
      body: JSON.stringify({ paneId: info!.id, event })
    })

  // No approve control while idle.
  await expect(row.locator('.approve-btn')).toHaveCount(0)

  await post('Notification')
  await expect(row.locator('.session-status')).toHaveText('needs you')

  // Arm: the peek shows the fixture's actual output — never blind.
  await expect(row.locator('.approve-btn')).toBeVisible()
  await expect(row.locator('.approve-confirm')).toHaveCount(0)
  await row.locator('.approve-btn').click()
  await expect(row.locator('.approve-peek')).toContainText('fake-claude started')

  // Cancel disarms without writing anything.
  await row.locator('.approve-cancel').click()
  await expect(row.locator('.approve-confirm')).toHaveCount(0)
  await win.waitForTimeout(250) // settle: a buggy cancel-write would land within this window
  expect(existsSync(join(userData, 'approve-marker'))).toBe(false)

  // Arm again and confirm: the fixture appends to the marker file, proving
  // the Enter reached its stdin — no terminal pane mounted at all.
  await row.locator('.approve-btn').click()
  await row.locator('.approve-confirm').click()
  await expect
    .poll(() => existsSync(join(userData, 'approve-marker')), { timeout: 5000 })
    .toBe(true)

  // Pane-header variant: open the pane, drive needs-you again, approve from
  // the header — the mounted terminal shows the fixture's echo this time.
  await row.locator('.row-open').click()
  const pane = win.locator(`[data-pane-id="${info!.id}"]`)
  await expect(pane).toBeVisible()
  await post('Notification')
  await expect(pane).toHaveAttribute('data-status', 'needs-you')
  await pane.locator('.approve-btn').click()
  await expect(pane.locator('.approve-peek')).toBeVisible()
  await pane.locator('.approve-confirm').click()
  await expect(pane.locator('.term-host')).toContainText('fake-claude got input')

  // The header control disappears once the session is no longer waiting.
  await post('Stop')
  await expect(pane).toHaveAttribute('data-status', 'idle')
  await expect(pane.locator('.approve-btn')).toHaveCount(0)

  await app.close()
})

test('cmd+u enters the environment view on a waiting pane and cycles', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'localflow-e2e-'))
  const app = await launchApp(userData)
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1400, height: 900 })
  await expect(win.locator('.new-session')).toBeVisible()

  const createSession = (cwd: string): Promise<{ id: string } | null> =>
    win.evaluate(
      (dir) =>
        (
          window as unknown as {
            localflow: { createSession(a: string, c: string): Promise<{ id: string } | null> }
          }
        ).localflow.createSession('claude', dir),
      cwd
    )

  const a = await createSession(userData)
  const b = await createSession(userData)
  const c = await createSession(userData)
  await expect(win.locator(`[data-session-id="${c!.id}"]`)).toBeVisible()

  const { port, token } = JSON.parse(readFileSync(join(userData, 'endpoint.json'), 'utf8'))
  const post = (paneId: string, event: string): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Localflow-Token': token },
      body: JSON.stringify({ paneId, event })
    })

  await post(b!.id, 'Notification')
  await post(c!.id, 'Notification')
  const rowB = win.locator(`[data-session-id="${b!.id}"]`)
  await expect(rowB.locator('.session-status')).toHaveText('needs you')

  // From the home overview, cmd+u enters the environment view directly on the
  // first waiting pane, enlarged (3 sessions exist).
  await win.keyboard.press('Meta+u')
  const paneB = win.locator(`[data-pane-id="${b!.id}"]`)
  const paneC = win.locator(`[data-pane-id="${c!.id}"]`)
  await expect(paneB).toBeVisible()
  await expect(paneB).toHaveClass(/active/)
  await expect(paneB).toHaveClass(/enlarged/)

  // Again: cycles to the next waiting pane.
  await win.keyboard.press('Meta+u')
  await expect(paneC).toHaveClass(/active/)
  await expect(paneC).toHaveClass(/enlarged/)
  await expect(paneB).not.toHaveClass(/enlarged/)

  // Again: wraps back.
  await win.keyboard.press('Meta+u')
  await expect(paneB).toHaveClass(/active/)

  // Nothing waiting -> no-op: focus stays put.
  await post(b!.id, 'Stop')
  await post(c!.id, 'Stop')
  await expect(paneB).toHaveAttribute('data-status', 'idle')
  await expect(paneC).toHaveAttribute('data-status', 'idle')
  await win.keyboard.press('Meta+u')
  await expect(paneB).toHaveClass(/active/)
  await expect(win.locator(`[data-pane-id="${a!.id}"]`)).not.toHaveClass(/active/)

  await app.close()
})

test('environments: switch, move, rollup dot, persistence', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'localflow-e2e-'))
  const app = await launchApp(userData)
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1400, height: 900 })
  await expect(win.locator('.new-session')).toBeVisible()

  const createSession = (cwd: string): Promise<{ id: string } | null> =>
    win.evaluate(
      (dir) =>
        (
          window as unknown as {
            localflow: { createSession(a: string, c: string): Promise<{ id: string } | null> }
          }
        ).localflow.createSession('claude', dir),
      cwd
    )

  // Two sessions created while environment 1 is current — both land on 1.
  const a = await createSession(userData)
  const b = await createSession(userData)
  await expect(win.locator(`[data-session-id="${b!.id}"]`)).toBeVisible()
  await win.locator(`[data-session-id="${a!.id}"]`).locator('.row-open').click()
  const paneA = win.locator(`[data-pane-id="${a!.id}"]`)
  const paneB = win.locator(`[data-pane-id="${b!.id}"]`)
  await expect(paneA).toBeVisible()
  await expect(paneB).toBeVisible()

  // cmd+2: switch to (empty) environment 2 — grid empties back to the landing.
  await win.keyboard.press('Meta+Digit2')
  await expect(win.locator('.pane')).toHaveCount(0)
  await expect(win.locator('.new-session')).toBeVisible()

  // While environment 2 is the visible one, create a session with an explicit
  // environment argument, exactly as App's createSession wrapper passes the
  // currently-visible `environment` state through to the IPC call. This
  // proves the IPC/session-manager path honors an explicit environment
  // end-to-end: the new pane must render immediately in environment 2's grid
  // (no switch needed) and must not appear once we're back on environment 1.
  // NOTE on coverage: driving this through the Landing's actual ".new-session"
  // button isn't headless-safe — under LOCALFLOW_E2E the folder-picker bypass
  // only triggers when an explicit cwd is passed, and the UI button doesn't
  // pass one, so clicking it would pop a real OS dialog and hang. So this
  // test cannot exercise the App-wrapper's pass-through of the visible
  // environment into that call; that link is covered by typecheck (environment
  // is a required prop threaded from state) and code review, not e2e.
  const c = await win.evaluate(
    (args) =>
      (
        window as unknown as {
          localflow: {
            createSession(
              a: string,
              c: string,
              cmd: undefined,
              env: number
            ): Promise<{ id: string } | null>
          }
        }
      ).localflow.createSession('claude', args.dir, undefined, args.env),
    { dir: userData, env: 2 }
  )
  const paneC = win.locator(`[data-pane-id="${c!.id}"]`)
  await expect(paneC).toBeVisible()

  // cmd+1: back — both original panes return, and the environment-2 session
  // created above is not among them.
  await win.keyboard.press('Meta+Digit1')
  await expect(win.locator('.pane')).toHaveCount(2)
  await expect(paneA).toHaveClass(/active/)
  await expect(paneC).toHaveCount(0)

  // ctrl+3 moves the ACTIVE pane (a) to environment 3: it leaves this
  // grid, focus lands on the remaining pane.
  await win.keyboard.press('Control+Digit3')
  await expect(win.locator('.pane')).toHaveCount(1)
  await expect(paneB).toHaveClass(/active/)

  // Sidebar shows environment 3 with a rollup dot; a needs-you event on the
  // moved session must turn exactly that dot yellow.
  const env3 = win.locator('[data-nav-environment="3"]')
  await expect(env3).toBeVisible()
  const { port, token } = JSON.parse(readFileSync(join(userData, 'endpoint.json'), 'utf8'))
  await fetch(`http://127.0.0.1:${port}/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Localflow-Token': token },
    body: JSON.stringify({ paneId: a!.id, event: 'Notification' })
  })
  await expect(env3.locator('.dot')).toHaveAttribute('data-status', 'needs-you')

  // Clicking the environment row switches the grid to it.
  await env3.click()
  await expect(win.locator('.pane')).toHaveCount(1)
  await expect(paneA).toBeVisible()

  // cmd+u from quiet environment 1 must jump cross-environment to pane a,
  // still waiting on environment 3 — focusing and enlarging it (more than one
  // session exists overall).
  await win.keyboard.press('Meta+Digit1')
  await win.keyboard.press('Meta+u')
  await expect(paneA).toBeVisible()
  await expect(paneA).toHaveClass(/active/)
  await expect(paneA).toHaveClass(/enlarged/)

  await app.close()

  // Relaunch: environment assignments persisted via sessions.json.
  const saved = JSON.parse(readFileSync(join(userData, 'sessions.json'), 'utf8')) as Array<{
    id: string
    environment?: number
  }>
  expect(saved.find((s) => s.id === a!.id)?.environment).toBe(3)
  expect(saved.find((s) => s.id === b!.id)?.environment).toBe(1)

  const app2 = await launchApp(userData)
  const win2 = await app2.firstWindow()
  await expect(win2.locator('[data-nav-environment="3"]')).toBeVisible()
  await app2.close()
})
