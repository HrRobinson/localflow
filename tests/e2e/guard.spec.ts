import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Same launchApp shape as smoke.spec.ts/console.spec.ts: per-test userData
 * dir, config.json pre-seeded with nonexistent codex/gemini paths so agent
 * detection short-circuits, fake-claude as the default terminal binary.
 *
 * lfguard itself is resolved by the running app at startup from
 * guard/target/release/lfguard when unpackaged (src/main/guard-binary.ts) —
 * these tests exercise the REAL binary, so `npm run build:guard` (or `npm
 * run e2e`, which chains it) must have produced that file before this spec
 * runs, or every guard-wiring assertion below fails closed (guard === null,
 * no PreToolUse/BeforeTool hook ever gets written).
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
      LOCALFLOW_OPENCLAW_CONFIG: join(userData, 'openclaw.json'),
      LOCALFLOW_LAZYGIT_BIN: '/nonexistent/lazygit',
      LOCALFLOW_EDITOR_BIN: '/nonexistent/code',
      LOCALFLOW_E2E_GO: join(userData, 'e2e-go')
    }
  })
}

interface Info {
  id: string
}

/** Renderer-side `window.localflow` surface this spec calls through IPC. */
type Api = {
  localflow: {
    createSession(agentId: string, cwd?: string): Promise<Info | null>
    peekSession(id: string, maxLines?: number): Promise<string[]>
  }
}

function createSessionIpc(win: Page, agentId: string, cwd: string): Promise<Info | null> {
  return win.evaluate(
    (args) => (window as unknown as Api).localflow.createSession(args.agentId, args.cwd),
    { agentId, cwd }
  )
}

function peekSessionIpc(win: Page, id: string, maxLines = 20): Promise<string[]> {
  return win.evaluate(
    (args) => (window as unknown as Api).localflow.peekSession(args.id, args.maxLines),
    { id, maxLines }
  )
}

/**
 * Runs a hook command string exactly as an agent's PreToolUse/BeforeTool
 * hook would: pipe a JSON payload on stdin via `sh -c`. Returns the exit
 * status — 0 means allow, anything else (lfguard's `--hook-exit` uses 2)
 * means the guard blocked the command.
 */
function runGuardHook(command: string, payload: string): number | null {
  try {
    execFileSync('/bin/sh', ['-c', command], { input: payload, stdio: ['pipe', 'pipe', 'pipe'] })
    return 0
  } catch (err) {
    return (err as { status: number | null }).status
  }
}

function preToolUsePayload(command: string): string {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command }
  })
}

test('claude: PreToolUse guard hook blocks rm -rf /, allows ls -la', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'localflow-e2e-'))
  const app = await launchApp(userData)
  const win = await app.firstWindow()
  await expect(win.locator('.new-session')).toBeVisible()

  const info = await createSessionIpc(win, 'claude', userData)
  expect(info).not.toBeNull()
  const row = win.locator(`[data-session-id="${info!.id}"]`)
  await expect(row).toBeVisible()
  await row.locator('.row-open').click()
  const pane = win.locator(`[data-pane-id="${info!.id}"]`)
  await expect(pane).toBeVisible()

  // Claude's hook adapter writes a settings file with a --settings CLI flag
  // (src/main/hook-settings.ts); the guard's PreToolUse entry lives inside
  // it once lfguard resolves (src/main/guard-binary.ts).
  const hooksFile = join(userData, `localflow-hooks-${info!.id}.json`)
  await expect.poll(() => existsSync(hooksFile)).toBe(true)
  const hooksJson = JSON.parse(readFileSync(hooksFile, 'utf8'))
  const guardCommand: string | undefined = hooksJson.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command
  expect(
    guardCommand,
    'guard was not wired into the Claude PreToolUse hook — is guard/target/release/lfguard built?'
  ).toBeTruthy()
  expect(guardCommand).toContain('lfguard')

  // Run the exact command localflow wrote, directly, with a real PreToolUse
  // payload piped in — proving the real lfguard binary blocks/allows, not a
  // mock.
  expect(runGuardHook(guardCommand!, preToolUsePayload('rm -rf /'))).not.toBe(0)
  expect(runGuardHook(guardCommand!, preToolUsePayload('ls -la'))).toBe(0)

  await app.close()
})

test('codex + gemini: guard hook wired into per-agent spawn args/settings', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'localflow-e2e-'))
  const app = await launchApp(userData, {
    codex: join(here, '../fixtures/fake-codex.sh'),
    gemini: join(here, '../fixtures/fake-gemini.sh')
  })
  const win = await app.firstWindow()
  await expect(win.locator('.new-session')).toBeVisible()

  // Codex: no on-disk settings file — the guard command is embedded inline
  // via `-c hooks.PreToolUse=...` CLI overrides plus
  // --dangerously-bypass-hook-trust (src/main/codex-hooks.ts). Read it back
  // via peekSession's tail buffer (fake-codex.sh echoes its own argv on
  // startup), never the mounted xterm DOM: the first output line can land
  // before a TerminalPane has mounted/subscribed — a real race documented
  // in groups.spec.ts, not just slow rendering.
  const codexInfo = await createSessionIpc(win, 'codex', userData)
  expect(codexInfo).not.toBeNull()
  await expect
    .poll(async () => (await peekSessionIpc(win, codexInfo!.id, 20)).join('\n'), {
      timeout: 10_000
    })
    .toContain('--dangerously-bypass-hook-trust')
  const codexTail = (await peekSessionIpc(win, codexInfo!.id, 20)).join('\n')
  expect(codexTail).toContain('hooks.PreToolUse=')

  // Gemini: guard lands in the written settings file as a BeforeTool hook
  // matched to run_shell_command (src/main/gemini-hooks.ts).
  const geminiInfo = await createSessionIpc(win, 'gemini', userData)
  expect(geminiInfo).not.toBeNull()
  const geminiHooksFile = join(userData, `localflow-gemini-hooks-${geminiInfo!.id}.json`)
  await expect.poll(() => existsSync(geminiHooksFile)).toBe(true)
  const geminiSettings = JSON.parse(readFileSync(geminiHooksFile, 'utf8'))
  expect(geminiSettings.hooks?.BeforeTool?.[0]?.matcher).toBe('run_shell_command')
  expect(geminiSettings.hooks?.BeforeTool?.[0]?.hooks?.[0]?.command).toContain('lfguard')

  await app.close()
})

test('settings: guard pack toggle threads --pack into the hook, persists', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'localflow-e2e-'))
  const app = await launchApp(userData)
  const win = await app.firstWindow()
  await expect(win.locator('.new-session')).toBeVisible()

  await win.getByRole('button', { name: 'Settings', exact: true }).click()
  const packToggle = win.locator('[data-guard-pack="cloud.gcloud"] input[type="checkbox"]')
  await expect(packToggle).toBeVisible()
  await expect(packToggle).not.toBeChecked()

  const configFile = join(userData, 'config.json')

  // Toggle on: persists to config.json's guard.packs, then threads into a
  // freshly-spawned pane's guard hook command.
  await packToggle.click()
  await expect(packToggle).toBeChecked()
  await expect
    .poll(() => JSON.parse(readFileSync(configFile, 'utf8')).guard?.packs)
    .toEqual(['cloud.gcloud'])

  await win.getByRole('button', { name: 'Overview', exact: true }).click()
  const onInfo = await createSessionIpc(win, 'claude', userData)
  expect(onInfo).not.toBeNull()
  const onHooksFile = join(userData, `localflow-hooks-${onInfo!.id}.json`)
  await expect.poll(() => existsSync(onHooksFile)).toBe(true)
  const onCommand = JSON.parse(readFileSync(onHooksFile, 'utf8')).hooks.PreToolUse[0].hooks[0]
    .command
  expect(onCommand).toContain('--pack cloud.gcloud')

  // Toggle off: persists back to an empty pack list, and a new pane's hook
  // no longer carries the flag.
  await win.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(packToggle).toBeChecked()
  await packToggle.click()
  await expect(packToggle).not.toBeChecked()
  await expect.poll(() => JSON.parse(readFileSync(configFile, 'utf8')).guard?.packs).toEqual([])

  await win.getByRole('button', { name: 'Overview', exact: true }).click()
  const offInfo = await createSessionIpc(win, 'claude', userData)
  expect(offInfo).not.toBeNull()
  const offHooksFile = join(userData, `localflow-hooks-${offInfo!.id}.json`)
  await expect.poll(() => existsSync(offHooksFile)).toBe(true)
  const offCommand = JSON.parse(readFileSync(offHooksFile, 'utf8')).hooks.PreToolUse[0].hooks[0]
    .command
  expect(offCommand).not.toContain('--pack cloud.gcloud')

  await app.close()
})

test('console: guard-blocked command appears as a guard row, expands to its reason', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'localflow-e2e-'))
  const app = await launchApp(userData)
  const win = await app.firstWindow()
  await expect(win.locator('.new-session')).toBeVisible()

  await win.keyboard.press('Meta+/')
  const drawer = win.locator('[data-console]')
  await expect(drawer).toBeVisible()

  // Mimics a real deny record — the exact shape lfguard's --audit-log
  // writes (GuardAuditRecord, src/shared/console.ts) — appended to the file
  // startGuardAuditTail polls (src/main/guard-audit-tail.ts). tag: null
  // mirrors a block with no matching live pane (falls back to environment 1
  // in main/index.ts), which is fine: the drawer's default "everywhere"
  // scope on the home view shows it regardless of environment.
  const record = {
    ts: Date.now(),
    tag: null,
    command: 'rm -rf /',
    reason:
      'recursive rm on a filesystem root, home, or system directory is catastrophic and irreversible',
    pack: 'core.filesystem'
  }
  appendFileSync(join(userData, 'guard-audit.jsonl'), JSON.stringify(record) + '\n')

  const guardRow = drawer.locator('[data-console-row][data-source="guard"]', {
    hasText: 'rm -rf /'
  })
  // The tail poll runs on a 1s interval — give it generous headroom.
  await expect(guardRow).toBeVisible({ timeout: 10_000 })

  // Expandable to its reason — no navigation away from the drawer.
  await expect(guardRow.locator('[data-console-detail]')).toHaveCount(0)
  await guardRow.click()
  const detail = guardRow.locator('[data-console-detail]')
  await expect(detail).toBeVisible()
  await expect(detail).toContainText('catastrophic and irreversible')

  await app.close()
})
