import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HookEventName } from '../shared/types'
import { guardHookCommand, type ResolvedGuard } from './guard-hook'

const EVENTS: HookEventName[] = ['UserPromptSubmit', 'Notification', 'Stop', 'PostToolUse']

const SAFE_TOKEN_RE = /^[A-Za-z0-9-]+$/

function assertSafeToken(value: string, name: string): void {
  if (!SAFE_TOKEN_RE.test(value)) {
    throw new Error(`invalid ${name}`)
  }
}

function assertValidPort(port: number): void {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('invalid port')
  }
}

export function buildHookSettings(
  paneId: string,
  port: number,
  token: string,
  guard: ResolvedGuard | null
): object {
  assertSafeToken(paneId, 'paneId')
  assertSafeToken(token, 'token')
  assertValidPort(port)
  const hooks: Record<string, unknown> = {}
  for (const event of EVENTS) {
    const payload = JSON.stringify({ paneId, event })
    const command = `curl -s -m 3 -X POST http://127.0.0.1:${port}/event -H 'Content-Type: application/json' -H 'X-Saiife-Token: ${token}' -d '${payload}'`
    hooks[event] = [{ hooks: [{ type: 'command', command }] }]
  }
  if (guard) {
    hooks.PreToolUse = [
      { matcher: 'Bash', hooks: [{ type: 'command', command: guardHookCommand(guard, paneId) }] }
    ]
  }
  return { hooks }
}

export function writeHookSettings(
  dir: string,
  paneId: string,
  port: number,
  token: string,
  guard: ResolvedGuard | null
): string {
  assertSafeToken(paneId, 'paneId')
  assertSafeToken(token, 'token')
  assertValidPort(port)
  const file = join(dir, `saiife-hooks-${paneId}.json`)
  writeFileSync(file, JSON.stringify(buildHookSettings(paneId, port, token, guard), null, 2), {
    mode: 0o600
  })
  return file
}

/**
 * Deletes the per-session settings file written above. Deleting a session is
 * best-effort cleanup: an unsafe paneId (possible via a hand-edited
 * sessions.json) never had a file written for it, and a missing file is fine
 * — so this never throws.
 */
export function removeHookSettings(dir: string, paneId: string): void {
  if (!SAFE_TOKEN_RE.test(paneId)) return
  try {
    rmSync(join(dir, `saiife-hooks-${paneId}.json`), { force: true })
  } catch {
    /* best-effort */
  }
}
