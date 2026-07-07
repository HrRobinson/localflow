import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HookEventName } from '../shared/types'

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
  const curl = `curl -s -m 3 -X POST http://127.0.0.1:${port}/event -H "Content-Type: application/json" -H "X-Localflow-Token: ${token}" -d '${payload}'`
  return `sh -c 'body=$(cat); case "$body" in *"\\"type\\":\\"ToolPermission\\""*|*"\\"type\\": \\"ToolPermission\\""*) ${curl} ;; esac'`
}

export function buildGeminiHookSettings(paneId: string, port: number, token: string): object {
  assertSafeToken(paneId, 'paneId')
  assertSafeToken(token, 'token')
  assertValidPort(port)
  return {
    hooks: {
      BeforeAgent: [
        {
          hooks: [
            { type: 'command', command: curlCommand(paneId, port, token, 'UserPromptSubmit') }
          ]
        }
      ],
      Notification: [
        { hooks: [{ type: 'command', command: notificationCommand(paneId, port, token) }] }
      ],
      AfterAgent: [
        { hooks: [{ type: 'command', command: curlCommand(paneId, port, token, 'Stop') }] }
      ]
    }
  }
}

export function writeGeminiHookSettings(
  dir: string,
  paneId: string,
  port: number,
  token: string
): string {
  assertSafeToken(paneId, 'paneId')
  assertSafeToken(token, 'token')
  assertValidPort(port)
  const file = join(dir, `localflow-gemini-hooks-${paneId}.json`)
  writeFileSync(file, JSON.stringify(buildGeminiHookSettings(paneId, port, token), null, 2), {
    mode: 0o600
  })
  return file
}
