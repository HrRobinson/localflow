import type {
  ClearSecretResult,
  IntegrationConfigFieldSpec,
  IntegrationDescriptor,
  IntegrationFieldValue,
  IntegrationFieldView,
  IntegrationId,
  IntegrationRegistry as IntegrationRegistryContract,
  IntegrationStatus,
  IntegrationView,
  IntegrationsConfig,
  SetEnabledResult,
  SetFieldResult,
  SetSecretResult
} from '../../shared/integrations'
import { INTEGRATION_IDS } from '../../shared/integrations'
import { DESCRIPTOR_DEFS } from './descriptors'
import type { CredentialStore } from './credential-store'
import { loadIntegrationsConfig, writeIntegrationEntry } from './integration-config'

/**
 * The single source of truth sub-projects 2 (Flow Engine) and 3 (Flow Canvas)
 * read. Holds the three descriptors and derives each one's SYNCHRONOUS,
 * presence-derived `status()` from config.json (§4.4) + `CredentialStore`
 * presence — it holds no I/O of its own beyond reading config + credential
 * presence. It NEVER exposes a secret value: the renderer DTO carries `hasValue`
 * booleans, never bytes.
 *
 * `invokeAction`/`subscribe` are the pinned contract's live-dispatch surface;
 * in the foundation slice they are minimal stubs (a legible "not wired yet"
 * throw / a no-op unsubscribe) with the exact signatures sub-project 2 aligns
 * to — live connector calls are deferred to Phase 2.
 */
export class IntegrationRegistry implements IntegrationRegistryContract {
  private readonly creds: CredentialStore
  private readonly configFile: string
  private readonly notify?: (message: string) => void

  constructor(deps: {
    creds: CredentialStore
    configFile: string
    notify?: (message: string) => void
  }) {
    this.creds = deps.creds
    this.configFile = deps.configFile
    this.notify = deps.notify
  }

  // ── Pinned contract ────────────────────────────────────────────────────────

  descriptors(): IntegrationDescriptor[] {
    return INTEGRATION_IDS.map((id) => this.get(id)).filter(
      (d): d is IntegrationDescriptor => d !== undefined
    )
  }

  get(id: IntegrationId): IntegrationDescriptor | undefined {
    const def = DESCRIPTOR_DEFS[id]
    if (!def) return undefined
    // Attach the presence-derived, synchronous `status()` closure (§11 note).
    return { ...def, status: (): IntegrationStatus => this.deriveStatus(id).status }
  }

  invokeAction(
    id: IntegrationId,
    actionId: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    void params // deferred: the Flow Engine (sub-project 2) supplies real params
    return Promise.reject(
      new Error(
        `The "${id}" action "${actionId}" isn't wired yet — live connector dispatch lands in the ` +
          `Flow Engine (sub-project 2). For now the Integrations Hub only stores, validates, and ` +
          `reports credential state.`
      )
    )
  }

  subscribe(id: IntegrationId, triggerId: string, handler: (event: unknown) => void): () => void {
    // No live trigger stream in the foundation slice — a no-op unsubscribe keeps
    // the pinned signature so sub-project 2 can align.
    void id
    void triggerId
    void handler
    return () => {}
  }

  // ── Renderer DTOs (secret VALUES excluded by construction) ──────────────────

  views(): IntegrationView[] {
    return INTEGRATION_IDS.map((id) => this.view(id))
  }

  view(id: IntegrationId): IntegrationView {
    const def = DESCRIPTOR_DEFS[id]
    const entry = this.config()[id]
    const values = entry?.values ?? {}
    const fields: IntegrationFieldView[] = def.configFields.map((f) => {
      if (f.secret) {
        return {
          key: f.key,
          label: f.label,
          secret: true,
          required: f.required,
          placeholder: f.placeholder,
          hasValue: this.creds.has(id, f.key)
        }
      }
      const raw = values[f.key]
      return {
        key: f.key,
        label: f.label,
        secret: false,
        required: f.required,
        placeholder: f.placeholder,
        hasValue: raw !== undefined,
        value: raw === undefined ? undefined : display(raw)
      }
    })
    const { status, detail } = this.deriveStatus(id)
    return {
      id,
      label: def.label,
      enabled: entry?.enabled ?? false,
      fields,
      status,
      statusDetail: detail
    }
  }

  // ── Mutations (config write-back / keychain) ────────────────────────────────

  setEnabled(id: IntegrationId, enabled: boolean): SetEnabledResult {
    if (!isId(id)) return { ok: false, reason: `Unknown integration "${String(id)}".` }
    try {
      const cur = this.config()[id] ?? { enabled: false, values: {} }
      writeIntegrationEntry(this.configFile, id, { enabled, values: cur.values })
      return { ok: true, view: this.view(id) }
    } catch (err) {
      return { ok: false, reason: (err as Error).message }
    }
  }

  setField(id: IntegrationId, key: string, value: string): SetFieldResult {
    if (!isId(id)) return { ok: false, reason: `Unknown integration "${String(id)}".` }
    const spec = DESCRIPTOR_DEFS[id].configFields.find((f) => f.key === key)
    if (!spec) return { ok: false, reason: `Unknown field "${key}" for "${id}".` }
    if (spec.secret) {
      return {
        ok: false,
        reason: `"${key}" is a secret — set it via the masked field, not a config field.`
      }
    }
    const coerced = coerceForWrite(spec, value)
    if ('error' in coerced) return { ok: false, reason: coerced.error }
    try {
      const cur = this.config()[id] ?? { enabled: false, values: {} }
      const values = { ...cur.values }
      if (coerced.clear) delete values[key]
      else values[key] = coerced.value
      writeIntegrationEntry(this.configFile, id, { enabled: cur.enabled, values })
      return { ok: true, view: this.view(id) }
    } catch (err) {
      return { ok: false, reason: (err as Error).message }
    }
  }

  setSecret(id: IntegrationId, key: string, value: string): SetSecretResult {
    if (!isId(id)) return { ok: false, reason: `Unknown integration "${String(id)}".` }
    const spec = DESCRIPTOR_DEFS[id].configFields.find((f) => f.key === key)
    if (!spec) return { ok: false, reason: `Unknown field "${key}" for "${id}".` }
    if (!spec.secret) {
      return {
        ok: false,
        reason: `"${key}" is a config field — set it via its text field, not the masked entry.`
      }
    }
    if (value.length === 0) {
      return { ok: false, reason: `Enter a value to store, or use Clear to remove the "${key}".` }
    }
    try {
      this.creds.set(id, key, value)
      // Return STATUS ONLY — the value is inbound-only and is never echoed back.
      return { ok: true, status: this.deriveStatus(id).status }
    } catch (err) {
      return { ok: false, reason: (err as Error).message }
    }
  }

  clearSecret(id: IntegrationId, key?: string): ClearSecretResult {
    if (!isId(id)) return { ok: false, reason: `Unknown integration "${String(id)}".` }
    try {
      this.creds.clear(id, key)
      return { ok: true, view: this.view(id) }
    } catch (err) {
      return { ok: false, reason: (err as Error).message }
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private config(): IntegrationsConfig {
    return loadIntegrationsConfig(this.configFile, this.notify)
  }

  /** Synchronous, presence-derived status (§4.2, §11). */
  private deriveStatus(id: IntegrationId): { status: IntegrationStatus; detail?: string } {
    const def = DESCRIPTOR_DEFS[id]
    const values = this.config()[id]?.values ?? {}
    // A stored secret that can't be decrypted is an error (state, not value).
    const decryptErr = this.creds.decryptionError(id)
    if (decryptErr) return { status: 'error', detail: decryptErr }
    const missing = def.configFields
      .filter((f) => f.required && !this.present(id, f, values))
      .map((f) => f.label)
    if (missing.length > 0) {
      return { status: 'needs-config', detail: `Needs: ${missing.join(', ')}.` }
    }
    return { status: 'connected' }
  }

  private present(
    id: IntegrationId,
    field: IntegrationConfigFieldSpec,
    values: Record<string, IntegrationFieldValue>
  ): boolean {
    if (field.secret) return this.creds.has(id, field.key)
    const v = values[field.key]
    if (Array.isArray(v)) return v.length > 0
    return v !== undefined
  }
}

function isId(id: IntegrationId): boolean {
  return (INTEGRATION_IDS as readonly string[]).includes(id)
}

/** Render a stored non-secret value as the text the UI field shows. */
function display(v: IntegrationFieldValue): string {
  if (Array.isArray(v)) return v.join(', ')
  return String(v)
}

type Coerced = { value: IntegrationFieldValue; clear?: false } | { clear: true } | { error: string }

/** Coerce a UI text value to its typed config value, or a legible rejection. */
function coerceForWrite(spec: IntegrationConfigFieldSpec, raw: string): Coerced {
  const trimmed = raw.trim()
  switch (spec.type) {
    case 'string':
      return trimmed.length === 0 ? { clear: true } : { value: trimmed }
    case 'string[]': {
      const arr = trimmed
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
      return arr.length === 0 ? { clear: true } : { value: arr }
    }
    case 'number': {
      if (trimmed.length === 0) return { clear: true }
      const n = Number(trimmed)
      if (!Number.isFinite(n)) return { error: `"${spec.label}" must be a number.` }
      if (spec.key === 'environment') {
        if (!Number.isInteger(n) || n < 1 || n > 9) {
          return { error: `"${spec.label}" must be a whole number from 1 to 9.` }
        }
        return { value: n }
      }
      if (spec.key === 'durationSeconds') {
        if (n <= 0) return { error: `"${spec.label}" must be a positive number of seconds.` }
        return { value: Math.min(Math.trunc(n), 1800) }
      }
      return { value: n }
    }
  }
}
