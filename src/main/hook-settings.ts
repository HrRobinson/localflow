import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HookEventName } from '../shared/types'

const EVENTS: HookEventName[] = ['UserPromptSubmit', 'Notification', 'Stop']

export function buildHookSettings(paneId: string, port: number, token: string): object {
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
  const file = join(dir, `localflow-hooks-${paneId}.json`)
  writeFileSync(file, JSON.stringify(buildHookSettings(paneId, port, token), null, 2))
  return file
}
