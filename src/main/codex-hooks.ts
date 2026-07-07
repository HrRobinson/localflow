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
 * Codex invokes its `notify` program with the notification JSON as a
 * single extra CLI argument appended to the configured program array
 * (`["sh","-c",script]`). For `sh -c 'script' extraArg`, POSIX assigns
 * that lone extra argument to `$0` (the conventional "command name"
 * slot), NOT `$1` — there is no `$1` unless a second extra argument is
 * also present. Verified empirically (see
 * tests/unit/codex-hooks.test.ts's executing test, mirroring the style
 * `sh -c 'echo "0=$0 1=$1"' arg-test` → `0=arg-test 1=`).
 *
 * Gate on `"$0$1"` (concatenated) rather than either alone: it matches
 * regardless of which positional slot the payload actually lands in,
 * so a future Codex invocation quirk that appends a second arg (making
 * the payload `$1` instead of `$0`) degrades to "no signal" rather than
 * silently never firing. This is the same "never wrong-but-confident"
 * gating style as gemini-hooks.ts's stdin `case` guard, adapted for
 * Codex's argv-based (not stdin-based) notification delivery.
 *
 * UNVERIFIED: the exact notification-type string (`agent-turn-complete`)
 * and which other notify invocations Codex fires (e.g. an
 * approval/error kind) are a research gap, not a confirmed fact — see
 * the manual verification checklist. If the real string differs, this
 * simply never fires (silent degradation to no signal), never on the
 * wrong condition.
 */
function notifyCommand(paneId: string, port: number, token: string): string {
  const curl = curlCommand(paneId, port, token, 'Stop')
  return `case "$0$1" in *agent-turn-complete*) ${curl} ;; esac`
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
    return ['-c', `notify=["sh","-c",${JSON.stringify(notifyCommand(paneId, port, token))}]`]
  }
  const table: [string, HookEventName][] = [
    ['UserPromptSubmit', 'UserPromptSubmit'],
    ['PermissionRequest', 'Notification'],
    ['Stop', 'Stop']
  ]
  return table.flatMap(([codexEvent, canonical]) => [
    '-c',
    `hooks.${codexEvent}=[{command=["sh","-c",${JSON.stringify(curlCommand(paneId, port, token, canonical))}]}]`
  ])
}
