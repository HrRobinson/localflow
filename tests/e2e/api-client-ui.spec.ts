import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

function launchApp(userData: string): Promise<ElectronApplication> {
  writeFileSync(
    join(userData, 'config.json'),
    JSON.stringify({ agentPaths: { codex: '/nonexistent/codex', gemini: '/nonexistent/gemini' } })
  )
  return electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      SAIIFE_E2E: '1',
      SAIIFE_USER_DATA: userData,
      SAIIFE_CLAUDE_BIN: join(here, '../fixtures/fake-claude.sh'),
      SAIIFE_OPENCLAW_CONFIG: join(userData, 'openclaw.json'),
      SAIIFE_LAZYGIT_BIN: '/nonexistent/lazygit',
      SAIIFE_EDITOR_BIN: '/nonexistent/code',
      SAIIFE_E2E_GO: join(userData, 'e2e-go')
    }
  })
}

test('curates a collection through the API client UI', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'sf-apiui-'))
  const app = await launchApp(userData)
  const win = await app.firstWindow()
  await expect(win.locator('.new-session')).toBeVisible()

  await win.getByRole('button', { name: 'API', exact: true }).click()
  await expect(win.locator('.api-client-view')).toBeVisible()

  // Create a collection.
  await win.locator('.api-client-new').click()
  await win.locator('.api-collection-name').fill('Stripe')
  await win.locator('.api-collection-origins').fill('https://api.stripe.com')
  await win.locator('.api-collection-secretref').fill('apiKey')
  await win.locator('.api-collection-save').click()

  await expect(win.locator('.api-client-panel[data-collection]')).toHaveCount(1)
  await expect(win.locator('.api-client-panel')).toContainText('Stripe')

  await app.close()
})

test('stores a credential write-only and edits a varSet', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'sf-apiui2-'))
  const app = await launchApp(userData)
  const win = await app.firstWindow()
  await expect(win.locator('.new-session')).toBeVisible()

  await win.getByRole('button', { name: 'API', exact: true }).click()
  await win.locator('.api-client-new').click()
  await win.locator('.api-collection-name').fill('Stripe')
  await win.locator('.api-collection-origins').fill('https://api.stripe.com')
  await win.locator('.api-collection-secretref').fill('apiKey')
  await win.locator('.api-collection-save').click()
  await expect(win.locator('.api-client-panel[data-collection]')).toHaveCount(1)

  // Store the credential — write-only. Value must never appear in the DOM.
  await win.locator('.api-secret').fill('sk_live_ui_secret')
  await win.locator('.api-secret-save').click()
  await expect(win.locator('.api-secret-set')).toBeVisible()
  expect(await win.locator('.api-client-view').innerText()).not.toContain('sk_live_ui_secret')

  await app.close()
})

test('flushes an unblurred varSet value edit before a sibling button persists', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'sf-apiui-flush-'))
  const app = await launchApp(userData)
  const win = await app.firstWindow()
  await expect(win.locator('.new-session')).toBeVisible()

  type Saiife = {
    saiife: {
      upsertCollection: (e: number, col: unknown) => Promise<unknown>
      listCollections: (e: number) => Promise<{ varSets: Record<string, Record<string, string>> }[]>
    }
  }

  // Seed a collection with one varSet and one variable via IPC (fast path;
  // UI curation of collections/varSets is covered by the tests above).
  await win.evaluate((c) => (window as unknown as Saiife).saiife.upsertCollection(1, c), {
    name: 'Stripe',
    origins: ['https://api.stripe.com'],
    auth: { scheme: 'bearer', secretRef: 'apiKey' },
    varSets: { live: { token: '' } },
    requests: []
  })

  await win.getByRole('button', { name: 'API', exact: true }).click()
  await expect(win.locator('.api-client-panel[data-collection]')).toHaveCount(1)
  await expect(win.locator('.api-var-value')).toHaveCount(1)

  // Pre-fill the new-set-name input first (a plain focus change, not part of
  // the scenario under test), THEN fill the value field — `fill` leaves focus
  // there, matching the real "typed a value, didn't tab out" case — and click
  // the `New varSet` BUTTON directly with no intervening focus change. Before
  // the fix, that button's mousedown suppressed the still-focused value
  // input's blur, so its persist call raced the value's own and won with a
  // stale snapshot that never saw the typed value.
  await win.getByPlaceholder('new varSet name, e.g. live').fill('backup')
  await win.locator('.api-var-value').fill('flushed-value-123')
  await win.locator('.api-varset-new').click()

  // 2 rename inputs (live, backup) + the still-present "new varSet name" input.
  await expect(win.locator('[data-collection] .api-varset-name')).toHaveCount(3)

  const collections = await win.evaluate(
    (e) => (window as unknown as Saiife).saiife.listCollections(e),
    1
  )
  expect(collections[0]?.varSets.live?.token).toBe('flushed-value-123')

  await app.close()
})

test('grants API access from the Cockpit', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'sf-apicockpit-'))
  const app = await launchApp(userData)
  const win = await app.firstWindow()
  await expect(win.locator('.new-session')).toBeVisible()

  // Curate a collection via IPC (fast path; the UI curation is covered elsewhere).
  await win.evaluate(
    (c) =>
      (
        window as unknown as {
          saiife: { upsertCollection: (e: number, col: unknown) => Promise<unknown> }
        }
      ).saiife.upsertCollection(1, c),
    {
      name: 'Stripe',
      origins: ['https://api.stripe.com'],
      auth: { scheme: 'bearer', secretRef: 'apiKey' },
      varSets: {},
      requests: []
    }
  )
  // Create a terminal pane to grant to.
  await win.evaluate(
    (cwd) =>
      (
        window as unknown as {
          saiife: { createSession: (a: string, c?: string) => Promise<unknown> }
        }
      ).saiife.createSession('claude', cwd),
    userData
  )

  await win.getByRole('button', { name: 'Cockpit', exact: true }).click()
  await expect(win.locator('.api-access')).toBeVisible()
  await expect(win.locator('.api-status')).toContainText('No API grant')

  // The pane just created via a raw IPC call (bypassing App's own
  // createSession, which refreshes `sessions` itself) only reaches Cockpit's
  // pane picker once App's 1s session poll picks it up — wait for its option
  // before selecting.
  await expect(win.locator('.api-pane-select option')).toHaveCount(2, { timeout: 5_000 })

  // Select the collection + pane, grant. The pane select's index 0 is the
  // "choose a pane…" placeholder, so the real pane is index 1.
  await win.locator('.api-collection-select').selectOption({ index: 0 })
  await win.locator('.api-pane-select').selectOption({ index: 1 })
  await win.locator('.api-grant-toggle').click()

  await expect(win.locator('.api-status')).toContainText('granted', { timeout: 10_000 })
  await expect(win.locator('.api-indicator[data-environment="1"]')).toBeVisible({
    timeout: 10_000
  })

  await app.close()
})
