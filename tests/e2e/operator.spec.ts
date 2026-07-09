import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Same launch shape as smoke.spec.ts: a temp userData dir, LOCALFLOW_E2E=1, the
 * fake-claude fixture as the terminal binary, and the codex/gemini paths pointed
 * at nonexistent files so their detection short-circuits without a login-shell
 * spawn. This spec drives the operator control API with Node `fetch` as the
 * scripted client, so it needs nothing beyond the smoke helper.
 */
function launchApp(userData: string): Promise<ElectronApplication> {
  writeFileSync(
    join(userData, 'config.json'),
    JSON.stringify({ agentPaths: { codex: '/nonexistent/codex', gemini: '/nonexistent/gemini' } })
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
      LOCALFLOW_E2E_GO: join(userData, 'e2e-go')
    }
  })
}

interface Session {
  id: string
  environment: number
}

/** A scripted control-API client bound to one grant (endpoint + bearer token). */
function makeClient(endpoint: string, token: string) {
  const call = (method: string, path: string, body?: unknown, bearer = token): Promise<Response> =>
    fetch(`${endpoint}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json'
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  return { call }
}

test('operator drives a granted environment and is denied cross-env', async () => {
  // De-risk note 3: navigate needs a real loadable http URL. Stand up a tiny
  // loopback server for the whole test; close it in teardown.
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.end('<!doctype html><title>operator-fixture</title><h1>operator fixture page</h1>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const pageUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`

  const userData = mkdtempSync(join(tmpdir(), 'localflow-e2e-'))
  const app = await launchApp(userData)

  try {
    const win = await app.firstWindow()
    await win.setViewportSize({ width: 1400, height: 900 })
    await expect(win.locator('.new-session')).toBeVisible()

    // --- 1. Create panes: an env-1 terminal + an env-1 browser, and a foreign
    //        env-2 terminal (the isolation subject). ---
    const term1 = await win.evaluate(
      (cwd) =>
        (
          window as unknown as {
            localflow: { createSession(a: string, c: string): Promise<Session> }
          }
        ).localflow.createSession('claude', cwd),
      userData
    )
    const web1 = await win.evaluate(
      (url) =>
        (
          window as unknown as {
            localflow: { createBrowserSession(u: string, e: number): Promise<Session> }
          }
        ).localflow.createBrowserSession(url, 1),
      pageUrl
    )
    const term2 = await win.evaluate(
      (cwd) =>
        (
          window as unknown as {
            localflow: {
              createSession(a: string, c: string, cmd: undefined, e: number): Promise<Session>
            }
          }
        ).localflow.createSession('claude', cwd, undefined, 2),
      userData
    )
    // De-risk note 2: prove the env-2 terminal genuinely lives on env 2 before
    // relying on it for the isolation assertion — otherwise a bad handle, not
    // scoping, could produce the 404 below.
    expect(term1!.environment).toBe(1)
    expect(web1!.environment).toBe(1)
    expect(term2!.environment).toBe(2)

    // --- 2. Enter the Cockpit (env 1 is active) and grant the operator. ---
    await win.getByRole('button', { name: 'Cockpit', exact: true }).click()
    await expect(win.locator('.operator-status')).toBeVisible()
    await expect(win.locator('.operator-status')).toHaveAttribute('data-connected', 'false')
    await win.locator('.operator-grant-toggle').click()

    // De-risk note 4: the operator endpoint + token land in operator-grant-1.json
    // under userData (Task 4, E2E-only). Poll for the file rather than sleeping.
    const grantFile = join(userData, 'operator-grant-1.json')
    await expect.poll(() => existsSync(grantFile), { timeout: 10_000 }).toBe(true)
    const grant = JSON.parse(readFileSync(grantFile, 'utf8')) as {
      endpoint: string
      token: string
      environment: number
    }
    expect(grant.environment).toBe(1)
    const client = makeClient(grant.endpoint, grant.token)

    // --- 3. Isolation: GET /panes returns only env-1 handles. ---
    const panesRes = await client.call('GET', '/panes')
    expect(panesRes.status).toBe(200)
    const { panes } = (await panesRes.json()) as { panes: { handle: string }[] }
    const handles = panes.map((p) => p.handle)
    expect(handles).toContain(term1!.id)
    expect(handles).toContain(web1!.id)
    expect(handles).not.toContain(term2!.id) // the cross-env isolation guarantee

    // --- 4. Foreign-env probe: env-1 token cannot resolve an env-2 handle. ---
    const foreign = await client.call('POST', `/panes/${term2!.id}/prompt`, { text: 'echo hi' })
    expect(foreign.status).toBe(404)

    // --- 5. No-grant probe: a bogus token never resolves to an environment. ---
    const bogus = await client.call('GET', '/panes', undefined, 'not-a-real-token')
    expect(bogus.status).toBe(403)

    // The first accepted request marks the grant connected; the Cockpit reflects
    // it live via the onOperatorActivity push.
    await expect(win.locator('.operator-status')).toHaveAttribute('data-connected', 'true')

    // --- 6. Drive the terminal. De-risk note 1: the pty does NOT echo the prompt
    //        text — fake-claude prints the literal "fake-claude got input" per
    //        stdin line. Prove the prompt reached the pty via the output route,
    //        corroborated by the cwd's approve-marker file. ---
    const promptRes = await client.call('POST', `/panes/${term1!.id}/prompt`, { text: 'echo hi' })
    expect(promptRes.status).toBe(200)
    await expect
      .poll(
        async () => {
          const r = await client.call('GET', `/panes/${term1!.id}/output`)
          if (r.status !== 200) return ''
          const { lines } = (await r.json()) as { lines: string[] }
          return lines.join('\n')
        },
        { timeout: 10_000 }
      )
      .toContain('fake-claude got input')
    // Corroboration: fake-claude appends to $PWD/approve-marker (PWD = cwd).
    await expect
      .poll(() => existsSync(join(userData, 'approve-marker')), { timeout: 10_000 })
      .toBe(true)

    // --- 9 (done while in the Cockpit): watchpoint + capture, then resume. ---
    const wpRes = await client.call('POST', '/watchpoints', {
      workflow: 'demo-workflow',
      step: 'verify',
      capture: ['output']
    })
    expect(wpRes.status).toBe(201)
    const { id: watchpointId } = (await wpRes.json()) as { id: string }

    const capRes = await client.call('POST', '/captures', {
      watchpointId,
      output: ['verified'],
      halted: true,
      resumeToken: 't'
    })
    expect(capRes.status).toBe(201)

    // The watch flips hit, and a halted capture row appears (Cockpit polls).
    await expect(
      win.locator(`.watchpoint-row[data-watchpoint-id="${watchpointId}"][data-hit="true"]`)
    ).toBeVisible({ timeout: 10_000 })
    const haltedRow = win.locator('.capture-row.halted')
    await expect(haltedRow).toBeVisible({ timeout: 10_000 })

    // Resume clears the halted flag (local resolve, surfaces the resume token).
    await haltedRow.locator('.capture-resume').click()
    await expect(win.locator('.capture-row.halted')).toHaveCount(0, { timeout: 10_000 })

    // --- 7. Drive the browser. The webview only registers its guest
    //        webContents while mounted in the environment grid, so switch to the
    //        env-1 grid first; the navigate poll then absorbs registration
    //        timing (it retries until the pane resolves). ---
    await win.getByRole('button', { name: 'Environment', exact: true }).click()
    await expect(win.locator(`[data-pane-id="${web1!.id}"] .browser-view`)).toBeVisible()

    await expect
      .poll(
        async () =>
          (await client.call('POST', `/panes/${web1!.id}/navigate`, { url: pageUrl })).status,
        { timeout: 20_000 }
      )
      .toBe(200)

    const shotRes = await client.call('POST', `/panes/${web1!.id}/screenshot`)
    expect(shotRes.status).toBe(200)
    const { path: shotPath } = (await shotRes.json()) as { path: string }
    expect(existsSync(shotPath)).toBe(true)

    // --- 8. Back in the Cockpit, the action log reflects the routes the
    //        scripted client drove, and the operator reads connected. ---
    await win.getByRole('button', { name: 'Cockpit', exact: true }).click()
    await expect(win.locator('.operator-status')).toHaveAttribute('data-connected', 'true')
    // The navigate poll below retries the fetch until the webview registers, so
    // it can log MORE than one "POST navigate" entry — match the first so a
    // registration retry never trips strict mode.
    const activity = win.locator('.operator-activity')
    await expect(
      activity.locator('.activity-entry[data-route="POST navigate"]').first()
    ).toBeVisible({ timeout: 10_000 })
    await expect(
      activity.locator('.activity-entry[data-route="POST screenshot"]').first()
    ).toBeVisible({ timeout: 10_000 })
    await expect(activity.locator('.activity-entry[data-route="POST prompt"]').first()).toBeVisible(
      { timeout: 10_000 }
    )

    // --- 10. Revoke via the toggle; the old token 403s immediately. ---
    await win.locator('.operator-grant-toggle').click()
    await expect
      .poll(async () => (await client.call('GET', '/panes')).status, { timeout: 10_000 })
      .toBe(403)
  } finally {
    await app.close()
    server.close()
  }
})
