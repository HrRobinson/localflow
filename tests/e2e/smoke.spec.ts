import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

test('panes render and hook events change status colors', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'localflow-e2e-'))
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      LOCALFLOW_E2E: '1',
      LOCALFLOW_USER_DATA: userData,
      LOCALFLOW_CLAUDE_BIN: join(here, '../fixtures/fake-claude.sh')
    }
  })
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
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      LOCALFLOW_E2E: '1',
      LOCALFLOW_USER_DATA: userData,
      LOCALFLOW_CLAUDE_BIN: join(here, '../fixtures/fake-claude.sh')
    }
  })
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
  await expect(win.locator('main h2')).toHaveText('Terminals')

  await app.close()
})
