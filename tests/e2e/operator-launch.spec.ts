import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Same launch shape as operator.spec.ts/smoke.spec.ts, plus
 * SAIIFE_OPENCLAW_BIN pointed at the fake-openclaw fixture — the only
 * addition this spec needs on top of the shared launchApp shape (Task 1's
 * bin-override plumbing in AgentRegistry/index.ts).
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
      SAIIFE_E2E: '1',
      SAIIFE_USER_DATA: userData,
      SAIIFE_CLAUDE_BIN: join(here, '../fixtures/fake-claude.sh'),
      SAIIFE_OPENCLAW_BIN: join(here, '../fixtures/fake-openclaw.sh'),
      // Keep the skill-env auto-writer away from any real ~/.openclaw config;
      // this path never exists, so the writer no-ops.
      SAIIFE_OPENCLAW_CONFIG: join(userData, 'openclaw.json'),
      SAIIFE_LAZYGIT_BIN: '/nonexistent/lazygit',
      SAIIFE_EDITOR_BIN: '/nonexistent/code',
      SAIIFE_E2E_GO: join(userData, 'e2e-go')
    }
  })
}

interface Session {
  id: string
  environment: number
}

/** A scripted control-API client bound to one grant (endpoint + bearer token). */
function makeClient(endpoint: string, token: string) {
  const call = (method: string, path: string, bearer = token): Promise<Response> =>
    fetch(`${endpoint}${path}`, {
      method,
      headers: { Authorization: `Bearer ${bearer}` }
    })
  return { call }
}

test('openclaw launch grants, injects credentials, and revokes on close', async () => {
  let app: ElectronApplication | undefined
  const userData = mkdtempSync(join(tmpdir(), 'saiife-e2e-'))
  const projectDir = mkdtempSync(join(tmpdir(), 'saiife-openclaw-proj-'))

  try {
    app = await launchApp(userData)
    const win = await app.firstWindow()
    await expect(win.locator('.new-session')).toBeVisible()

    // --- 2. Create the OpenClaw session in environment 1, with a known cwd
    //        so the fixture's marker file lands somewhere findable. ---
    const created = await win.evaluate(
      (args) =>
        (
          window as unknown as {
            saiife: {
              createSession(
                a: string,
                c: string,
                cmd: undefined,
                e: number
              ): Promise<Session | null>
            }
          }
        ).saiife.createSession('openclaw', args.cwd, undefined, args.env),
      { cwd: projectDir, env: 1 }
    )
    expect(created).not.toBeNull()
    expect(created!.environment).toBe(1)

    // --- 3. The fixture writes endpoint=/token= to $PWD (=projectDir) on
    //        spawn — poll for it rather than assuming spawn timing. ---
    const markerFile = join(projectDir, 'openclaw-env-marker')
    await expect.poll(() => existsSync(markerFile), { timeout: 10_000 }).toBe(true)
    const markerText = readFileSync(markerFile, 'utf8')
    const endpoint = /^endpoint=(.*)$/m.exec(markerText)?.[1] ?? ''
    const token = /^token=(.*)$/m.exec(markerText)?.[1] ?? ''
    expect(endpoint).not.toBe('')
    expect(token).not.toBe('')

    // --- 4. The injected credential really drives environment 1: GET /panes
    //        with it succeeds and includes the OpenClaw pane's own handle
    //        (it is itself a terminal pane in env 1). ---
    const client = makeClient(endpoint, token)
    const panesRes = await client.call('GET', '/panes')
    expect(panesRes.status).toBe(200)
    const { panes } = (await panesRes.json()) as { panes: { handle: string }[] }
    expect(panes.map((p) => p.handle)).toContain(created!.id)

    // --- 5. Cockpit reflects env 1 granted: the status badge is present
    //        (and, since the GET above already made an authenticated
    //        request, connected), and the sidebar shows the env-1 dot. ---
    await win.getByRole('button', { name: 'Cockpit', exact: true }).click()
    await expect(win.locator('.operator-status[data-connected]')).toBeVisible()
    await expect(win.locator('.operator-status')).toHaveAttribute('data-connected', 'true')
    await expect(win.locator('.operator-indicator[data-environment="1"]')).toBeVisible({
      timeout: 10_000
    })

    // --- 6. Revoke-on-close: deleting the launched session must revoke the
    //        grant it created — the OLD token stops resolving immediately. ---
    await win.evaluate(
      (id) =>
        (
          window as unknown as { saiife: { deleteSession(id: string): Promise<void> } }
        ).saiife.deleteSession(id),
      created!.id
    )
    await expect
      .poll(async () => (await client.call('GET', '/panes')).status, { timeout: 10_000 })
      .toBe(403)
  } finally {
    if (app) await app.close()
    rmSync(userData, { recursive: true, force: true })
    rmSync(projectDir, { recursive: true, force: true })
  }
})
