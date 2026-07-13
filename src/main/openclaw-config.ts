import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Auto-writes the localflow skill env into an EXISTING OpenClaw config on
 * grant, and removes exactly that entry on revoke — the block the manual
 * setup documents (openclaw/skills/localflow/README.md). Deliberately
 * conservative, because the file is user-owned: localflow never creates it,
 * never touches any key other than `skills.entries.localflow.env`, and treats
 * every failure as non-fatal (the grant itself must still succeed; the caller
 * surfaces a warning). Token values never appear in results or logs.
 */

/** Where the documented manual setup puts per-skill env. */
export function defaultOpenclawConfig(): string {
  return join(homedir(), '.openclaw', 'openclaw.json')
}

export type SkillEnvResult = { ok: true; written: boolean } | { ok: false; reason: string }

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** A missing config is the normal no-OpenClaw case — a silent no-op, not a failure. */
function load(configFile: string): { config: Obj } | { skip: true } | { fail: string } {
  if (!existsSync(configFile)) return { skip: true }
  let raw: string
  try {
    raw = readFileSync(configFile, 'utf8')
  } catch {
    return { fail: 'config unreadable' }
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isObj(parsed)) return { fail: 'config is not a JSON object' }
    return { config: parsed }
  } catch {
    return { fail: 'config is malformed JSON' }
  }
}

function persist(configFile: string, config: Obj): SkillEnvResult {
  try {
    // Read-modify-write of the parsed tree: every other key round-trips.
    writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n')
    return { ok: true, written: true }
  } catch {
    return { ok: false, reason: 'config write failed' }
  }
}

/**
 * Sets `skills.entries.localflow.env` to this grant's credentials. Missing
 * containers along the path are created as objects; a container that exists
 * with a non-object shape belongs to the user and is never replaced (fail
 * instead). Never creates the config file itself.
 */
export function writeSkillEnv(configFile: string, endpoint: string, token: string): SkillEnvResult {
  const loaded = load(configFile)
  if ('skip' in loaded) return { ok: true, written: false }
  if ('fail' in loaded) return { ok: false, reason: loaded.fail }
  const { config } = loaded
  let node = config
  for (const key of ['skills', 'entries', 'localflow']) {
    const next = node[key]
    if (next === undefined) {
      const created: Obj = {}
      node[key] = created
      node = created
    } else if (isObj(next)) {
      node = next
    } else {
      return { ok: false, reason: `${key} is not an object` }
    }
  }
  node['env'] = { LOCALFLOW_ENDPOINT: endpoint, LOCALFLOW_TOKEN: token }
  return persist(configFile, config)
}

/**
 * Removes exactly `skills.entries.localflow.env` (revoke). Any other key —
 * including sibling keys the user keeps under `localflow` — stays untouched;
 * an absent path is a no-op.
 */
export function removeSkillEnv(configFile: string): SkillEnvResult {
  const loaded = load(configFile)
  if ('skip' in loaded) return { ok: true, written: false }
  if ('fail' in loaded) return { ok: false, reason: loaded.fail }
  const { config } = loaded
  const skills = config['skills']
  if (!isObj(skills)) return { ok: true, written: false }
  const entries = skills['entries']
  if (!isObj(entries)) return { ok: true, written: false }
  const localflow = entries['localflow']
  if (!isObj(localflow) || !('env' in localflow)) return { ok: true, written: false }
  delete localflow['env']
  return persist(configFile, config)
}
