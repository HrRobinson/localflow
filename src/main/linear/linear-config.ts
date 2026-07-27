import type { AgentId } from '../../shared/types'

/**
 * The `linear` block of config.json (spec §7), parsed config-as-code and
 * validated at the boundary exactly like `parseOperatorRevokeOnExit` in
 * `operator-config.ts`: config.json is user-edited, so only well-typed values
 * are honored and any garbage DISABLES the feature (returns `null`) rather than
 * throwing. An absent/disabled block means the connector never starts — the
 * opt-in posture the OpenClaw operator launch took (spec §4.1).
 *
 * Secrets are NOT here: the OAuth tokens and the webhook signing secret live in
 * the keychain (spec §5). This block holds only references and non-secret ids.
 */

/**
 * Terminal agents a Linear-driven pane may be spawned as. Deliberately mirrors
 * `OPERATOR_TERMINAL_AGENTS` in `control-api.ts` — this is a capability
 * boundary, not a shape check: 'shell' and 'openclaw' are excluded so a
 * Linear-sourced prompt can never reach a raw shell or an ungated operator
 * agent. Kept in sync with that set by intent; a Linear pane is created through
 * the same guarded control-API route (spec §4.6).
 */
const LINEAR_TERMINAL_AGENTS: ReadonlySet<AgentId> = new Set<AgentId>(['claude', 'codex', 'gemini'])

export interface LinearConfig {
  enabled: true
  /** Linear org id — a reference, not a secret (spec §7). */
  workspaceId: string
  /** Which saiife environment (1-9) hosts Linear work. */
  environment: number
  /** The agent Linear-driven panes spawn as; within `LINEAR_TERMINAL_AGENTS`. */
  agentId: AgentId
  /** The registered ingress URL (tunnel/relay). Must be https (spec §4.4). */
  webhookUrl: string
  /** Optional workflow-state id to move the issue to on close (spec §6.3). */
  moveToStateOnDone?: string
  /** Optional team scoping; omit for `allPublicTeams` (spec §6.1). */
  teamIds?: string[]
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function isHttpsUrl(v: unknown): v is string {
  if (typeof v !== 'string') return false
  try {
    return new URL(v).protocol === 'https:'
  } catch {
    return false
  }
}

function optionalStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined
  if (!v.every(isNonEmptyString)) return undefined
  return v
}

/**
 * Validate the parsed config.json object's `linear` block. Returns a fully
 * typed `LinearConfig` when the required references are all well-typed and the
 * feature is enabled, else `null` (feature off). Malformed OPTIONAL fields are
 * dropped while the feature stays on.
 */
export function parseLinearConfig(raw: unknown): LinearConfig | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const block = (raw as { linear?: unknown }).linear
  if (typeof block !== 'object' || block === null || Array.isArray(block)) return null

  const b = block as Record<string, unknown>
  if (b.enabled !== true) return null
  if (!isNonEmptyString(b.workspaceId)) return null
  if (typeof b.environment !== 'number' || !Number.isInteger(b.environment)) return null
  if (b.environment < 1 || b.environment > 9) return null
  if (typeof b.agentId !== 'string' || !LINEAR_TERMINAL_AGENTS.has(b.agentId as AgentId))
    return null
  if (!isHttpsUrl(b.webhookUrl)) return null

  const cfg: LinearConfig = {
    enabled: true,
    workspaceId: b.workspaceId,
    environment: b.environment,
    agentId: b.agentId as AgentId,
    webhookUrl: b.webhookUrl
  }
  if (isNonEmptyString(b.moveToStateOnDone)) cfg.moveToStateOnDone = b.moveToStateOnDone
  const teamIds = optionalStringArray(b.teamIds)
  if (teamIds) cfg.teamIds = teamIds
  return cfg
}
