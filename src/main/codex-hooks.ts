import type { HookEventName } from '../shared/types'

export type CodexHookTier = 'full' | 'notify' | 'none'

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
 * Codex hook injection via `-c key=value` overrides — no on-disk config
 * file is touched. UNVERIFIED: the exact `-c` value grammar below is a
 * best-effort guess at Codex's TOML-override-style CLI syntax and MUST be
 * confirmed/corrected against a real `codex --help`/docs before the
 * 'full' tier is trusted in production (see the plan's Task 4 manual
 * verification checklist). What IS verified here, independent of that
 * grammar: tier selection, canonical-event mapping, and safe embedding of
 * paneId/port/token.
 */
export function buildCodexHookArgs(
  paneId: string,
  port: number,
  token: string,
  tier: CodexHookTier
): string[] {
  assertSafeToken(paneId, 'paneId')
  assertSafeToken(token, 'token')
  assertValidPort(port)
  if (tier === 'none') return []
  if (tier === 'notify') {
    return ['-c', `notify=["sh","-c","${curlCommand(paneId, port, token, 'Stop')}"]`]
  }
  const table: [string, HookEventName][] = [
    ['UserPromptSubmit', 'UserPromptSubmit'],
    ['PermissionRequest', 'Notification'],
    ['Stop', 'Stop']
  ]
  return table.flatMap(([codexEvent, canonical]) => [
    '-c',
    `hooks.${codexEvent}=[{command=["sh","-c","${curlCommand(paneId, port, token, canonical)}"]}]`
  ])
}
