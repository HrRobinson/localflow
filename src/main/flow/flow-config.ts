import { readFileSync } from 'node:fs'
import { clampEnvironment } from '../../shared/environment'

/**
 * The `flows` enablement block from config.json (config-as-code, like
 * `operator-config.ts` / `editor-config.ts`). Non-secret refs only — never a
 * token. Absent or `enabled:false` ⇒ the engine never starts (opt-in, off by
 * default), so saiife's "works with no flow configured" guarantee holds.
 */
export interface FlowsConfig {
  enabled: boolean
  /** Default saiife environment (1-9) hosting flow-driven panes. */
  environment: number
  /** RAM-safe cap on concurrent live agent panes (dev-machine memory note). */
  maxConcurrentPanes: number
}

const DISABLED: FlowsConfig = { enabled: false, environment: 1, maxConcurrentPanes: 2 }

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Validates the `flows` block. Only well-typed values are honored; garbage
 *  disables the feature (the `operator-config.ts` boundary discipline). */
export function parseFlowsConfig(raw: unknown): FlowsConfig {
  if (!isObject(raw) || !isObject(raw.flows)) return { ...DISABLED }
  const block = raw.flows
  const enabled = block.enabled === true
  if (!enabled) return { ...DISABLED }
  const environment = clampEnvironment(block.environment)
  const cap = block.maxConcurrentPanes
  const maxConcurrentPanes =
    typeof cap === 'number' && Number.isFinite(cap) ? Math.max(1, Math.trunc(cap)) : 2
  return { enabled, environment, maxConcurrentPanes }
}

/** Reads the flag fresh from config.json — hand edits apply without a restart,
 *  and any read/parse error simply disables the feature (never throws). */
export function loadFlowsConfig(configFile: string): FlowsConfig {
  try {
    return parseFlowsConfig(JSON.parse(readFileSync(configFile, 'utf8')))
  } catch {
    return { ...DISABLED }
  }
}
