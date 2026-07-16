/**
 * Canonical human-facing string for a guard deny (SYS-8). Both the pane
 * notice and the JSON `error` field in control-api's guard-blocked prompt
 * response render this exact string, so an operator sees ONE message
 * regardless of which surface they're looking at — never a generic
 * "blocked by command guard" that drops which pack fired or what to do
 * next. Messaging only; callers still get the raw `reason`/`pack` fields
 * alongside this for programmatic use.
 */
export function guardDenyMessage(pack: string, reason: string): string {
  return `Blocked by guard pack '${pack}': ${reason}. Edit the command or disable the pack in Settings.`
}
