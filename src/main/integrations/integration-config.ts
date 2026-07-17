import { readFileSync, writeFileSync } from 'node:fs'
import type {
  IntegrationConfigFieldSpec,
  IntegrationFieldValue,
  IntegrationId,
  IntegrationsConfig
} from '../../shared/integrations'
import { INTEGRATION_IDS } from '../../shared/integrations'
import { DESCRIPTOR_DEFS } from './descriptors'

/**
 * The non-secret `integrations` block of config.json — config-as-code, read
 * FRESH each call (hand edits apply without a restart) and validated AT THE
 * BOUNDARY: every field is checked against its descriptor and anything
 * malformed is DROPPED, never thrown on. Mirrors `parseEnvironmentNames` /
 * `parseOperatorRevokeOnExit` exactly. Secrets never live here — a `secret:true`
 * key found in config.json is dropped and a loud notice is emitted (§8), so the
 * never-render-secrets rule holds even against a hand-edit mistake.
 */

const DURATION_CAP = 1800

type Notify = (message: string) => void

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Coerce+validate one non-secret field value against its declared type. */
function parseField(
  spec: IntegrationConfigFieldSpec,
  raw: unknown
): IntegrationFieldValue | undefined {
  switch (spec.type) {
    case 'string': {
      if (typeof raw !== 'string') return undefined
      const trimmed = raw.trim()
      return trimmed.length === 0 ? undefined : trimmed
    }
    case 'string[]': {
      if (!Array.isArray(raw)) return undefined
      const out = raw
        .filter((el): el is string => typeof el === 'string')
        .map((el) => el.trim())
        .filter((el) => el.length > 0)
      return out
    }
    case 'number': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined
      if (spec.key === 'environment') {
        return Number.isInteger(raw) && raw >= 1 && raw <= 9 ? raw : undefined
      }
      if (spec.key === 'durationSeconds') {
        if (raw <= 0) return undefined
        return Math.min(Math.trunc(raw), DURATION_CAP)
      }
      return raw
    }
  }
}

function parseEntry(
  id: IntegrationId,
  raw: Record<string, unknown>,
  notify?: Notify
): IntegrationsConfig[IntegrationId] {
  const values: Record<string, IntegrationFieldValue> = {}
  for (const spec of DESCRIPTOR_DEFS[id].configFields) {
    const provided = raw[spec.key]
    if (provided === undefined) continue
    if (spec.secret) {
      // A secret must never live in config.json — drop it and say so loudly,
      // proving state (that it was ignored), never the value.
      notify?.(
        `"${id}.${spec.key}" is a secret and was ignored in config.json — set it in the ` +
          `Integrations tab; it belongs in the keychain.`
      )
      continue
    }
    const parsed = parseField(spec, provided)
    if (parsed !== undefined) values[spec.key] = parsed
  }
  return { enabled: raw.enabled === true, values }
}

/** Validate-at-the-boundary parse of the `integrations` block (§8). */
export function parseIntegrationsConfig(raw: unknown, notify?: Notify): IntegrationsConfig {
  if (!isObj(raw)) return {}
  const block = raw.integrations
  if (!isObj(block)) return {}
  const out: IntegrationsConfig = {}
  for (const id of INTEGRATION_IDS) {
    const entry = block[id]
    if (!isObj(entry)) continue
    out[id] = parseEntry(id, entry, notify)
  }
  return out
}

/** Reads the block fresh from config.json — unreadable/garbage → all disabled. */
export function loadIntegrationsConfig(configFile: string, notify?: Notify): IntegrationsConfig {
  try {
    return parseIntegrationsConfig(JSON.parse(readFileSync(configFile, 'utf8')), notify)
  } catch {
    return {}
  }
}

/**
 * Read-modify-write the `integrations` block of config.json, preserving every
 * other key (the `openclaw-config.ts` / `saveAgentConfig` pattern). Secret
 * fields are NEVER written here. Throws a legible error on a write failure so
 * the caller can roll an optimistic UI update back.
 */
export function writeIntegrationEntry(
  configFile: string,
  id: IntegrationId,
  entry: IntegrationsConfig[IntegrationId]
): void {
  let root: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(configFile, 'utf8'))
    if (isObj(parsed)) root = parsed
  } catch {
    root = {} // missing/garbage config — start a fresh tree, same as first run
  }
  const block = isObj(root.integrations) ? { ...root.integrations } : {}
  block[id] = { enabled: entry?.enabled ?? false, ...entry?.values }
  root.integrations = block
  try {
    writeFileSync(configFile, JSON.stringify(root, null, 2) + '\n')
  } catch (err) {
    throw new Error(
      `Couldn't save the "${id}" integration config — ${(err as Error).message}. ` +
        `The change wasn't persisted; try again.`,
      { cause: err }
    )
  }
}
