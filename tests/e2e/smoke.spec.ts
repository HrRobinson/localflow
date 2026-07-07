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
      LOCALFLOW_CLAUDE_BIN: join(here, '../fixtures/fake-claude.sh')
    }
  })
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

  // fake-codex.sh eval's the extracted Stop-mapped curl ~3s after start,
  // with no further help from the test — this is the fixture proving
  // localflow's -c injection reaches a real child process and executes.
  // Generous explicit timeout: the 3s fixture delay is measured from
  // process spawn, well before this point in the test, so the default 5s
  // expect timeout leaves too little margin under load.
  await expect(pane).toHaveAttribute('data-status', 'idle', { timeout: 10_000 })
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

  // fake-gemini.sh runs BeforeAgent (~2.5s post-spawn), then
  // Notification(ToolPermission) (+2s), then AfterAgent (+2s more),
  // entirely on its own — the three assertions below are driven purely by
  // the fixture actually executing localflow's injected commands, no
  // manual fetch() POSTs involved. Generous explicit timeouts: each delay
  // is measured from process spawn, well before this point in the test.
  await expect(pane).toHaveAttribute('data-status', 'working', { timeout: 10_000 })
  await expect(pane).toHaveAttribute('data-status', 'needs-you', { timeout: 10_000 })
  await expect(pane).toHaveAttribute('data-status', 'idle', { timeout: 10_000 })

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
  // to start from a plain, unenlarged terminals view for the nav assertions.
  const first = await createSession(userData)
  const firstRow = win.locator(`[data-session-id="${first!.id}"]`)
  await expect(firstRow).toBeVisible()
  await firstRow.locator('.row-open').click()

  const firstPane = win.locator(`[data-pane-id="${first!.id}"]`)
  await expect(firstPane).toBeVisible()
  await expect(firstPane).toHaveClass(/active/)

  // Now bring in a second session while already in the terminals view.
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
  // the terminals grid actually mounts for the final pane-absence check —
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

  // Back to Terminals via the sidebar: with the second session keeping the
  // grid mounted, exactly the deleted pane is gone and the survivor renders
  // — proving the delete removed the right session, not that the grid was
  // simply unmounted.
  await win.getByRole('button', { name: 'Terminals', exact: true }).click()
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
