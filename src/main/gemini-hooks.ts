import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HookEventName } from '../shared/types'
import { guardHookCommand, type ResolvedGuard } from './guard-hook'

const SAFE_TOKEN_RE = /^[A-Za-z0-9-]+$/

function assertSafeToken(value: string, name: string): void {
  if (!SAFE_TOKEN_RE.test(value)) throw new Error(`invalid ${name}`)
}

function assertValidPort(port: number): void {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('invalid port')
  }
}

function curlCommand(paneId: string, port: number, token: string, event: HookEventName): string {
  const payload = JSON.stringify({ paneId, event })
  return `curl -s -m 3 -X POST http://127.0.0.1:${port}/event -H 'Content-Type: application/json' -H 'X-Localflow-Token: ${token}' -d '${payload}'`
}

/**
 * UNVERIFIED: the exact stdin field name/casing Gemini uses to mark a
 * ToolPermission notification is a research gap, not a confirmed fact —
 * see module doc / spec. If it differs, this simply never fires
 * (silent partial degradation), it never fires on the wrong condition.
 */
function notificationCommand(paneId: string, port: number, token: string): string {
  const payload = JSON.stringify({ paneId, event: 'Notification' as HookEventName })
  // The whole command below is itself wrapped in an outer `sh -c '...'`, so a
  // plain `-d '<payload>'` would prematurely close that outer single-quoted
  // string the moment it hit payload's own single quotes — corrupting the
  // curl invocation the outer shell sees before the inner `sh -c` ever runs.
  // `'"'"'` is the standard POSIX trick for embedding a literal single quote
  // inside an already-open single-quoted string (close quote, insert a
  // double-quoted single quote, reopen quote), so the payload still reaches
  // curl as one properly single-quoted argument.
  const quotedPayload = `'"'"'${payload}'"'"'`
  const curl = `curl -s -m 3 -X POST http://127.0.0.1:${port}/event -H "Content-Type: application/json" -H "X-Localflow-Token: ${token}" -d ${quotedPayload}`
  return `sh -c 'body=$(cat); case "$body" in *"\\"type\\":\\"ToolPermission\\""*|*"\\"type\\": \\"ToolPermission\\""*) ${curl} ;; esac'`
}

export function buildGeminiHookSettings(
  paneId: string,
  port: number,
  token: string,
  guard: ResolvedGuard | null
): object {
  assertSafeToken(paneId, 'paneId')
  assertSafeToken(token, 'token')
  assertValidPort(port)
  const hooks: Record<string, unknown> = {
    BeforeAgent: [
      {
        hooks: [{ type: 'command', command: curlCommand(paneId, port, token, 'UserPromptSubmit') }]
      }
    ],
    Notification: [
      { hooks: [{ type: 'command', command: notificationCommand(paneId, port, token) }] }
    ],
    AfterAgent: [
      { hooks: [{ type: 'command', command: curlCommand(paneId, port, token, 'Stop') }] }
    ]
  }
  if (guard) {
    hooks.BeforeTool = [
      {
        matcher: 'run_shell_command',
        hooks: [{ type: 'command', command: guardHookCommand(guard, paneId) }]
      }
    ]
  }
  return { hooks }
}

export function writeGeminiHookSettings(
  dir: string,
  paneId: string,
  port: number,
  token: string,
  guard: ResolvedGuard | null
): string {
  assertSafeToken(paneId, 'paneId')
  assertSafeToken(token, 'token')
  assertValidPort(port)
  const file = join(dir, `localflow-gemini-hooks-${paneId}.json`)
  writeFileSync(
    file,
    JSON.stringify(buildGeminiHookSettings(paneId, port, token, guard), null, 2),
    {
      mode: 0o600
    }
  )
  return file
}

/**
 * Deletes the per-session settings file written above. Same best-effort
 * contract as removeHookSettings (hook-settings.ts): never throws, and an
 * unsafe paneId never had a file written for it in the first place.
 */
export function removeGeminiHookSettings(dir: string, paneId: string): void {
  if (!SAFE_TOKEN_RE.test(paneId)) return
  try {
    rmSync(join(dir, `localflow-gemini-hooks-${paneId}.json`), { force: true })
  } catch {
    /* best-effort */
  }
}
