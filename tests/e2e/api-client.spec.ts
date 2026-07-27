import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { SaiifeApi } from '../../src/shared/api'

const here = dirname(fileURLToPath(import.meta.url))
const execFileAsync = promisify(execFile)

/** Same cast pattern as operator.spec.ts: `window.saiife` only typechecks under
 *  tsconfig.web.json, and this spec lives under tsconfig.node.json's DOM-less lib —
 *  each `evaluate` callback below re-casts `window` locally, since it runs in the
 *  renderer and can't close over a node-scope helper. */
type WithSaiife = { saiife: SaiifeApi }

/** Same launch shape as operator.spec.ts. `extraEnv` layers on top for the one
 *  test (below) that needs the fake-claude fixture to dump its own env. */
function launchApp(
  userData: string,
  extraEnv: Record<string, string> = {}
): Promise<ElectronApplication> {
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
      SAIIFE_E2E_GO: join(userData, 'e2e-go'),
      ...extraEnv
    }
  })
}

const COLLECTION = {
  name: 'Stripe',
  origins: ['https://api.stripe.com'],
  auth: { scheme: 'bearer', secretRef: 'apiKey' },
  varSets: { test: { base_url: 'https://api.stripe.com' } },
  requests: [{ id: 'charges', name: 'Charges', method: 'GET', path: '/v1/charges' }]
}

test('curates a collection and stores its credential', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'sf-apiclient-'))
  const app = await launchApp(userData)
  const win = await app.firstWindow()
  await expect(win.locator('.new-session')).toBeVisible()

  // Create.
  const created = await win.evaluate(
    (c) => (window as unknown as WithSaiife).saiife.upsertCollection(1, c),
    COLLECTION
  )
  expect(created.ok).toBe(true)
  if (!created.ok) throw new Error(created.reason)
  const id = created.view.id
  expect(id.length).toBeGreaterThan(0)
  expect(created.view.hasSecret).toBe(false)
  expect(created.view.environment).toBe(1)

  // List is environment-scoped.
  expect(
    await win.evaluate(() => (window as unknown as WithSaiife).saiife.listCollections(1))
  ).toHaveLength(1)
  expect(
    await win.evaluate(() => (window as unknown as WithSaiife).saiife.listCollections(2))
  ).toHaveLength(0)

  // Secret is write-only: the result carries presence, never the value.
  const stored = await win.evaluate(
    (cid) =>
      (window as unknown as WithSaiife).saiife.setCollectionSecret(
        1,
        cid,
        'apiKey',
        'sk_live_e2e_secret'
      ),
    id
  )
  expect(stored).toEqual({ ok: true, hasSecret: true })
  const afterStore = await win.evaluate(() =>
    (window as unknown as WithSaiife).saiife.listCollections(1)
  )
  expect(afterStore[0].hasSecret).toBe(true)
  expect(JSON.stringify(afterStore)).not.toContain('sk_live_e2e_secret')

  // A secret-shaped varSet value is refused before it reaches disk.
  const refused = await win.evaluate(
    (c) =>
      (window as unknown as WithSaiife).saiife.upsertCollection(1, {
        ...c,
        varSets: { test: { k: 'sk_live_leak' } }
      }),
    COLLECTION
  )
  expect(refused.ok).toBe(false)
  if (!refused.ok) expect(refused.reason).toMatch(/secretRef/)

  // Clear, then remove.
  expect(
    await win.evaluate(
      (cid) => (window as unknown as WithSaiife).saiife.clearCollectionSecret(1, cid, 'apiKey'),
      id
    )
  ).toEqual({
    ok: true
  })
  expect(
    await win.evaluate(
      (cid) => (window as unknown as WithSaiife).saiife.removeCollection(1, cid),
      id
    )
  ).toEqual({ ok: true })
  expect(
    await win.evaluate(() => (window as unknown as WithSaiife).saiife.listCollections(1))
  ).toHaveLength(0)

  await app.close()
})

test('removing a collection without clearing its secret first still erases the ciphertext (I3)', async () => {
  // Regression for the 2026-07-24 review finding I3: ids are randomUUID() and
  // never reused, so a credential left behind under a removed collection's id
  // is unreachable forever — the fix removes the secret as part of
  // apiClient:removeCollection, not as a UI-level "clear first" convention.
  const userData = mkdtempSync(join(tmpdir(), 'sf-apiorphan-'))
  const app = await launchApp(userData)
  const win = await app.firstWindow()
  await expect(win.locator('.new-session')).toBeVisible()

  const created = await win.evaluate(
    (c) => (window as unknown as WithSaiife).saiife.upsertCollection(1, c),
    COLLECTION
  )
  expect(created.ok).toBe(true)
  if (!created.ok) throw new Error(created.reason)
  const id = created.view.id

  const stored = await win.evaluate(
    (cid) =>
      (window as unknown as WithSaiife).saiife.setCollectionSecret(
        1,
        cid,
        'apiKey',
        'sk_live_e2e_orphan'
      ),
    id
  )
  expect(stored).toEqual({ ok: true, hasSecret: true })

  // Remove WITHOUT clearing the secret first.
  expect(
    await win.evaluate(
      (cid) => (window as unknown as WithSaiife).saiife.removeCollection(1, cid),
      id
    )
  ).toEqual({ ok: true })

  await app.close()

  // The ciphertext sidecar must carry no entry for this collection's id —
  // `collectionSecretKey` length-prefixes the id, so this substring can only
  // match as that exact segment, not a coincidental overlap.
  const secretsFile = readFileSync(join(userData, 'api-secrets.enc'), 'utf8')
  expect(secretsFile).not.toContain(`${id.length}:${id}:`)
})

test('grants API access to a pane and the token reaches it', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'sf-apigrant-'))
  const app = await launchApp(userData)
  const win = await app.firstWindow()
  await expect(win.locator('.new-session')).toBeVisible()

  const created = await win.evaluate(
    (c) => (window as unknown as WithSaiife).saiife.upsertCollection(1, c),
    COLLECTION
  )
  if (!created.ok) throw new Error(created.reason)
  const collectionId = created.view.id

  const session = await win.evaluate(
    (cwd) => (window as unknown as WithSaiife).saiife.createSession('claude', cwd),
    userData
  )
  if (!session) throw new Error('createSession returned null')
  const paneId = session.id

  expect(
    await win.evaluate(() => (window as unknown as WithSaiife).saiife.apiGrantStatus(1))
  ).toMatchObject({ granted: false })

  const granted = await win.evaluate(
    ([pid, cid]) => (window as unknown as WithSaiife).saiife.grantApiAccess(1, pid, [cid]),
    [paneId, collectionId] as const
  )
  expect(granted.ok).toBe(true)
  if (!granted.ok) throw new Error(granted.reason)
  expect(granted.paneId).toBe(paneId)
  expect(granted.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  // The token is NEVER returned to the renderer.
  expect(JSON.stringify(granted)).not.toMatch(/token/i)

  const status = await win.evaluate(() =>
    (window as unknown as WithSaiife).saiife.apiGrantStatus(1)
  )
  expect(status).toMatchObject({ granted: true, paneId, collectionIds: [collectionId] })

  // Granting with no collections is meaningless and refused.
  const empty = await win.evaluate(
    (pid) => (window as unknown as WithSaiife).saiife.grantApiAccess(1, pid, []),
    paneId
  )
  expect(empty.ok).toBe(false)

  // Granting to an unknown pane is refused.
  const ghost = await win.evaluate(() =>
    (window as unknown as WithSaiife).saiife.grantApiAccess(1, 'no-such-pane', ['x'])
  )
  expect(ghost.ok).toBe(false)

  // Granting to a pane in a different environment is refused.
  const foreign = await win.evaluate(
    ([pid, cid]) => (window as unknown as WithSaiife).saiife.grantApiAccess(2, pid, [cid]),
    [paneId, collectionId] as const
  )
  expect(foreign.ok).toBe(false)

  await win.evaluate(() => (window as unknown as WithSaiife).saiife.revokeApiAccess(1))
  expect(
    await win.evaluate(() => (window as unknown as WithSaiife).saiife.apiGrantStatus(1))
  ).toMatchObject({ granted: false })

  await app.close()
})

test('moving a granted pane to another environment revokes the grant (I4)', async () => {
  // Regression for the 2026-07-24 review finding I4: session:setEnvironment
  // used to mutate rec.info.environment without touching apiGrants/
  // apiGrantBinding, so the pane kept SAIIFE_API_TOKEN scoped to the
  // environment it left — invisibly, since the Cockpit in the new
  // environment showed "No API grant". The fix revokes on move; re-minting
  // for the new environment is deliberately NOT done (different scope).
  const userData = mkdtempSync(join(tmpdir(), 'sf-apimove-'))
  const app = await launchApp(userData)
  const win = await app.firstWindow()
  await expect(win.locator('.new-session')).toBeVisible()

  const created = await win.evaluate(
    (c) => (window as unknown as WithSaiife).saiife.upsertCollection(1, c),
    COLLECTION
  )
  if (!created.ok) throw new Error(created.reason)
  const collectionId = created.view.id

  const session = await win.evaluate(
    (cwd) => (window as unknown as WithSaiife).saiife.createSession('claude', cwd),
    userData
  )
  if (!session) throw new Error('createSession returned null')
  const paneId = session.id

  const granted = await win.evaluate(
    ([pid, cid]) => (window as unknown as WithSaiife).saiife.grantApiAccess(1, pid, [cid]),
    [paneId, collectionId] as const
  )
  expect(granted.ok).toBe(true)

  // Move the pane to environment 2.
  await win.evaluate(
    (pid) => (window as unknown as WithSaiife).saiife.setEnvironment(pid, 2),
    paneId
  )

  // The old environment's grant must be gone...
  expect(
    await win.evaluate(() => (window as unknown as WithSaiife).saiife.apiGrantStatus(1))
  ).toMatchObject({ granted: false })
  // ...and the new environment must NOT have silently inherited it either.
  expect(
    await win.evaluate(() => (window as unknown as WithSaiife).saiife.apiGrantStatus(2))
  ).toMatchObject({ granted: false })

  await app.close()
})

test('refuses API access to a pane that holds an operator grant', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'sf-apidouble-'))
  const app = await launchApp(userData)
  const win = await app.firstWindow()
  await expect(win.locator('.new-session')).toBeVisible()

  const created = await win.evaluate(
    (c) => (window as unknown as WithSaiife).saiife.upsertCollection(1, c),
    COLLECTION
  )
  if (!created.ok) throw new Error(created.reason)
  const collectionId = created.view.id

  // Grant an operator on env 1 and launch its openclaw pane, so the pane is a
  // live operator-launch pane. grantOperator + a companion pane is how the app
  // does it; here we drive the IPC the Cockpit toggle uses, then create the
  // openclaw pane the operator owns.
  const opPane = await win.evaluate(
    (cwd) => (window as unknown as WithSaiife).saiife.createSession('openclaw', cwd),
    userData
  )
  if (!opPane) throw new Error('operator pane not created')

  // Attempt to grant API access to that same operator pane — must be refused.
  const refused = await win.evaluate(
    ([pid, cid]) => (window as unknown as WithSaiife).saiife.grantApiAccess(1, pid, [cid]),
    [opPane.id, collectionId] as const
  )
  expect(refused.ok).toBe(false)
  if (!refused.ok) expect(refused.reason).toMatch(/operator/i)

  await app.close()
})

test('the grant dies when its pane is deleted, and survives a restart', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'sf-apidelete-'))
  const app = await launchApp(userData)
  const win = await app.firstWindow()
  await expect(win.locator('.new-session')).toBeVisible()

  const created = await win.evaluate(
    (c) => (window as unknown as WithSaiife).saiife.upsertCollection(1, c),
    COLLECTION
  )
  if (!created.ok) throw new Error(created.reason)
  const collectionId = created.view.id

  const session = await win.evaluate(
    (cwd) => (window as unknown as WithSaiife).saiife.createSession('claude', cwd),
    userData
  )
  if (!session) throw new Error('createSession returned null')
  const paneId = session.id

  const granted = await win.evaluate(
    ([pid, cid]) => (window as unknown as WithSaiife).saiife.grantApiAccess(1, pid, [cid]),
    [paneId, collectionId] as const
  )
  expect(granted.ok).toBe(true)
  expect(
    await win.evaluate(() => (window as unknown as WithSaiife).saiife.apiGrantStatus(1))
  ).toMatchObject({ granted: true, paneId, collectionIds: [collectionId] })

  // Granting restarted the pane (to inject the env). The grant SURVIVES that —
  // a restart is an exit, not a deletion. `restartSession` only accepts an
  // already-exited pane (mirrors the real "close" button → resume flow in
  // smoke.spec.ts), so close it first.
  await win.evaluate((pid) => (window as unknown as WithSaiife).saiife.closeTerminal(pid), paneId)
  await win.evaluate(
    (pid) => (window as unknown as WithSaiife).saiife.restartSession(pid, false),
    paneId
  )
  expect(
    await win.evaluate(() => (window as unknown as WithSaiife).saiife.apiGrantStatus(1))
  ).toMatchObject({ granted: true, paneId })

  // Deleting the pane revokes WITHOUT an explicit revoke call.
  await win.evaluate((pid) => (window as unknown as WithSaiife).saiife.deleteSession(pid), paneId)
  await expect
    .poll(
      async () =>
        (await win.evaluate(() => (window as unknown as WithSaiife).saiife.apiGrantStatus(1)))
          .granted,
      { timeout: 10_000 }
    )
    .toBe(false)

  await app.close()
})

test('chains a withheld token into a second request without reading it', async () => {
  const seen: string[] = []
  const upstream = createServer((req, res) => {
    seen.push((req.headers['x-auth'] as string | undefined) ?? '')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ access_token: 'tok_e2e_secret', ok: true }))
  })
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()))
  const origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`

  const userData = mkdtempSync(join(tmpdir(), 'sf-apichain-'))
  // `grantApiAccess` deliberately never returns the token over IPC (see the
  // grant test above) — the fake-claude fixture dumping its own
  // SAIIFE_API_ENDPOINT/SAIIFE_API_TOKEN to stdout when this is set is the
  // only way to get the token OUT of the pane from the harness, without
  // inventing a new IPC that would leak it for real.
  const app = await launchApp(userData, { SAIIFE_E2E_DUMP_ENV: '1' })
  const win = await app.firstWindow()
  await expect(win.locator('.new-session')).toBeVisible()

  const created = await win.evaluate(
    (o) =>
      (window as unknown as WithSaiife).saiife.upsertCollection(1, {
        name: 'Local',
        origins: [o],
        allowLocal: true,
        auth: { scheme: 'none' },
        varSets: { dev: { base_url: o } },
        requests: [{ id: 'r', name: 'r', method: 'GET', path: '/first' }]
      }),
    origin
  )
  if (!created.ok) throw new Error(created.reason)
  const cid = created.view.id

  const session = await win.evaluate(
    (cwd) => (window as unknown as WithSaiife).saiife.createSession('claude', cwd),
    userData
  )
  if (!session) throw new Error('no session')
  const paneId = session.id

  const granted = await win.evaluate(
    ([pid, c]) => (window as unknown as WithSaiife).saiife.grantApiAccess(1, pid, [c]),
    [paneId, cid] as const
  )
  if (!granted.ok) throw new Error(granted.reason)

  // Open the pane so its terminal mounts. `TerminalPane` replays the pane's
  // rendered screen on mount (`snapshotSession`), so this shows the dump
  // whether it printed before or after the mount raced it.
  const row = win.locator(`[data-session-id="${paneId}"]`)
  await expect(row).toBeVisible({ timeout: 10_000 })
  await row.locator('.row-open').click()
  const pane = win.locator(`[data-pane-id="${paneId}"]`)
  await expect(pane.locator('.term-host')).toContainText('SAIIFE_API_TOKEN=', { timeout: 10_000 })
  const dumped = await pane.locator('.term-host').innerText()
  const tokenMatch = /SAIIFE_API_TOKEN=(\S+)/.exec(dumped)
  if (!tokenMatch) throw new Error('token not found in pane output')
  const token = tokenMatch[1]

  // Drive the two sends with the REAL CLI an agent would run, per SKILL.md —
  // never through a test-only IPC. `execFile`, async: a sync child here would
  // block this process's event loop, which Playwright also needs to keep
  // pumping CDP traffic to/from the Electron app.
  const cliPath = join(here, '../../openclaw/skills/saiife-api/bin/saiife-api.mjs')
  const cliEnv = { ...process.env, SAIIFE_API_ENDPOINT: granted.endpoint, SAIIFE_API_TOKEN: token }
  const runCli = async (args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync('node', [cliPath, ...args], { env: cliEnv })
    return stdout
  }

  const firstOut = await runCli(['send', cid, '--request', 'r', '--varset', 'dev'])
  const first = JSON.parse(firstOut) as { responseId: string }

  const spec = JSON.stringify({
    method: 'GET',
    path: '/second',
    headers: { 'x-auth': { $ref: `${first.responseId}:$['access_token']` } }
  })
  const secondOut = await runCli(['send', cid, '--spec', spec, '--varset', 'dev'])

  expect(seen[1]).toBe('tok_e2e_secret') // upstream got the chained value
  expect(firstOut + secondOut).not.toContain('tok_e2e_secret') // the agent never did

  upstream.close()
  await app.close()
})
