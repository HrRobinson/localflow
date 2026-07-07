import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Launch the app against a userData dir. Pre-seeds/merges config.json with
 * absolute, nonexistent paths for the agents we don't fake (codex, gemini)
 * so their detection short-circuits through existsSync instead of racing a
 * real (slow) login-shell `command -v` lookup against expect()'s timeouts.
 * Merges rather than overwrites so a relaunch against the same userData
 * (e.g. to check lastAgent persistence) doesn't clobber what was saved.
 */
function launchApp(userData: string): Promise<ElectronApplication> {
  const configFile = join(userData, 'config.json')
  const existing: { agentPaths?: Record<string, string> } = existsSync(configFile)
    ? JSON.parse(readFileSync(configFile, 'utf8'))
    : {}
  writeFileSync(
    configFile,
    JSON.stringify({
      ...existing,
      agentPaths: {
        ...existing.agentPaths,
        codex: '/nonexistent/codex',
        gemini: '/nonexistent/gemini'
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
