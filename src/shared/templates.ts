import type { AgentId } from './types'
import { AGENT_PRESETS } from './agents'
import { normalizeHttpUrl } from './urls'

/** Agent ids launchable from a template pane (presets only — no 'custom': a
 * template has no field to carry a custom command line). */
const TEMPLATE_AGENT_IDS = new Set(AGENT_PRESETS.map((p) => p.id))

export interface TemplatePane {
  kind: 'terminal' | 'browser'
  /** terminal only; defaults to 'claude' when absent. */
  agentId?: AgentId
  /** browser only; required (normalizes to isHttpUrl-safe form via normalizeHttpUrl at spawn). */
  url?: string
}

export interface SessionTemplate {
  name: string
  panes: TemplatePane[]
}

/**
 * One raw pane entry -> a valid TemplatePane, or null when malformed. Never
 * throws — config.json is hand-edited, so a bad entry is skipped rather than
 * failing the whole template (see parseSessionTemplates).
 */
function parsePane(raw: unknown): TemplatePane | null {
  if (typeof raw !== 'object' || raw === null) return null
  const kind = (raw as { kind?: unknown }).kind
  if (kind === 'terminal') {
    const agentIdRaw = (raw as { agentId?: unknown }).agentId
    if (agentIdRaw === undefined) return { kind: 'terminal', agentId: 'claude' }
    if (typeof agentIdRaw === 'string' && TEMPLATE_AGENT_IDS.has(agentIdRaw as AgentId)) {
      return { kind: 'terminal', agentId: agentIdRaw as AgentId }
    }
    // An explicit-but-unrecognized agentId is malformed, not "absent" — skip
    // the pane rather than silently substituting a different agent.
    return null
  }
  if (kind === 'browser') {
    const url = (raw as { url?: unknown }).url
    if (typeof url !== 'string' || normalizeHttpUrl(url) === null) return null
    return { kind: 'browser', url }
  }
  return null
}

/**
 * One raw template entry -> a valid SessionTemplate, or null when malformed
 * (missing/blank name, non-array panes, or every pane in it turned out
 * malformed — a template with zero launchable panes is nothing to show).
 */
function parseTemplate(raw: unknown): SessionTemplate | null {
  if (typeof raw !== 'object' || raw === null) return null
  const name = (raw as { name?: unknown }).name
  if (typeof name !== 'string' || name.trim().length === 0) return null
  const panesRaw = (raw as { panes?: unknown }).panes
  if (!Array.isArray(panesRaw)) return null
  const panes = panesRaw.map(parsePane).filter((pane): pane is TemplatePane => pane !== null)
  if (panes.length === 0) return null
  return { name: name.trim(), panes }
}

/**
 * config.json's `sessionTemplates` array -> valid SessionTemplates only.
 * Non-fatal by design: config.json is user-edited, so a malformed entry (or
 * a non-array `raw`) is skipped rather than throwing.
 */
export function parseSessionTemplates(raw: unknown): SessionTemplate[] {
  if (!Array.isArray(raw)) return []
  return raw.map(parseTemplate).filter((t): t is SessionTemplate => t !== null)
}
