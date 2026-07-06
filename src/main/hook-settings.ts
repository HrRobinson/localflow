import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HookEventName } from '../shared/types'

const EVENTS: HookEventName[] = ['UserPromptSubmit', 'Notification', 'Stop']

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

export function buildHookSettings(paneId: string, port: number, token: string): object {
  assertSafeToken(paneId, 'paneId')
  assertSafeToken(token, 'token')
  assertValidPort(port)
  const hooks: Record<string, unknown> = {}
  for (const event of EVENTS) {
    const payload = JSON.stringify({ paneId, event })
    const command = `curl -s -m 3 -X POST http://127.0.0.1:${port}/event -H 'Content-Type: application/json' -H 'X-Localflow-Token: ${token}' -d '${payload}'`
    hooks[event] = [{ hooks: [{ type: 'command', command }] }]
  }
  return { hooks }
}

export function writeHookSettings(
  dir: string,
  paneId: string,
  port: number,
  token: string
): string {
  assertSafeToken(paneId, 'paneId')
  assertSafeToken(token, 'token')
  assertValidPort(port)
  const file = join(dir, `localflow-hooks-${paneId}.json`)
  writeFileSync(file, JSON.stringify(buildHookSettings(paneId, port, token), null, 2), {
    mode: 0o600
  })
  return file
}
