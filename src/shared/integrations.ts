/**
 * Integrations Hub — the pinned cross-project contract (sub-project #1 of the
 * visual-flows pilot). This file is the SOLE authority for the
 * `IntegrationDescriptor` / `IntegrationRegistry` shapes; the Flow Engine (#2)
 * and Flow Canvas (#3) reconcile against it. No I/O — shared by main and
 * renderer.
 */

// ── Pinned contract (verbatim; #2/#3 consume these names) ────────────────────

export type IntegrationId =
  | 'linear'
  | 'email'
  | 'cloud'
  | 'shopify'
  | 'woocommerce'
  | 'posthog'
  | 'gitlab'
  | 'slack'
  | 'http'
  | 'stripe'
  | 'github'
  | 'sentry'
  | 'hubspot'
  | 'discord'

export interface IntegrationConfigField {
  key: string
  label: string
  secret: boolean
  required: boolean
  placeholder?: string
}

export interface IntegrationDescriptor {
  id: IntegrationId
  label: string
  configFields: IntegrationConfigField[]
  triggers: { id: string; label: string }[]
  actions: { id: string; label: string }[]
  status(): IntegrationStatus
}

export interface IntegrationRegistry {
  descriptors(): IntegrationDescriptor[]
  get(id: IntegrationId): IntegrationDescriptor | undefined
  /**
   * Invoke an integration action. **Failure convention:** an action signals
   * failure by REJECTING the returned promise (throwing) — a resolved promise
   * (any value, including `undefined`) is treated as success by the engine's
   * action-runner. This matches the pinned `invokeAction(): Promise<unknown>`.
   */
  invokeAction(
    id: IntegrationId,
    actionId: string,
    params: Record<string, unknown>
  ): Promise<unknown>
  subscribe(
    id: IntegrationId,
    triggerId: string,
    handler: (event: unknown) => void,
    config?: Record<string, unknown>
  ): () => void
}

/**
 * The MINIMAL live-dispatch seam a connector implements so the registry's pinned
 * `invokeAction`/`subscribe` (today's stubs) can delegate to real Shopify/Linear/
 * email/cloud work (§4.3). Per-integration (the id is already known when it is
 * registered), so it drops the `id` argument the registry surface carries. Same
 * FAILURE CONVENTION as the registry: an action signals failure by REJECTING the
 * returned promise; a resolved value (incl. `undefined`) is success.
 */
export interface LiveConnector {
  invokeAction(actionId: string, params: Record<string, unknown>): Promise<unknown>
  /**
   * Register a trigger subscription. The OPTIONAL `config` carries the flow
   * trigger NODE's config — webhook connectors (Shopify/Woo/Linear/Stripe) don't
   * need it and may keep the 2-arg form, but a POLL connector (PostHog) reads it
   * to know WHAT to poll (insightId / cohortId / threshold / event filter).
   */
  subscribe(
    triggerId: string,
    handler: (event: unknown) => void,
    config?: Record<string, unknown>
  ): () => void
}

// ── Additions this sub-project owns (internal + UI DTOs) ─────────────────────

/**
 * The synchronous presence-derived state the pinned `status()` returns.
 * `'disabled'` = a config entry exists for the integration but is not enabled;
 * the engine refuses any non-`'connected'` integration, so opt-in is
 * enforceable (a configured-but-disabled integration is NOT `'connected'`).
 */
export type IntegrationStatus = 'connected' | 'needs-config' | 'error' | 'disabled'

/** Stable order for `descriptors()` / the tabs — the contract 2/3 rely on. */
export const INTEGRATION_IDS: readonly IntegrationId[] = [
  'linear',
  'email',
  'cloud',
  'shopify',
  'woocommerce',
  'posthog',
  'gitlab',
  'slack',
  'http',
  'stripe',
  'github',
  'sentry',
  'hubspot',
  'discord'
]

/**
 * The value type a non-secret config field carries in config.json. Drives
 * validate-at-the-boundary (§8) — secret fields never appear here.
 */
export type FieldType = 'string' | 'string[]' | 'number'

/**
 * The static descriptor field spec. Extends the pinned `IntegrationConfigField`
 * with an internal `type` used only for config validation/coercion; because it
 * is a superset, a `IntegrationConfigFieldSpec[]` satisfies the pinned
 * `configFields: IntegrationConfigField[]` for 2/3.
 */
export interface IntegrationConfigFieldSpec extends IntegrationConfigField {
  type: FieldType
}

/**
 * The static half of a descriptor (everything but `status()`), authored in
 * `src/main/integrations/descriptors/*.ts`. The registry composes the full
 * `IntegrationDescriptor` by attaching a presence-derived `status()` closure.
 */
export interface IntegrationDescriptorDef {
  id: IntegrationId
  label: string
  configFields: IntegrationConfigFieldSpec[]
  triggers: { id: string; label: string }[]
  actions: { id: string; label: string }[]
}

// ── Config-as-code shape (non-secret refs only; §6, §8) ──────────────────────

export type IntegrationFieldValue = string | string[] | number

export interface IntegrationConfigEntry {
  enabled: boolean
  values: Record<string, IntegrationFieldValue>
}

export type IntegrationsConfig = Partial<Record<IntegrationId, IntegrationConfigEntry>>

// ── Renderer DTOs — secret VALUES excluded by construction (§4.5) ────────────

export interface IntegrationFieldView {
  key: string
  label: string
  secret: boolean
  required: boolean
  placeholder?: string
  /** For secret fields: presence only — never the value. */
  hasValue: boolean
  /** For NON-secret fields only (read back from config.json). */
  value?: string
}

export interface IntegrationView {
  id: IntegrationId
  label: string
  enabled: boolean
  fields: IntegrationFieldView[]
  status: IntegrationStatus
  /** Legible error text when `status === 'error'`. */
  statusDetail?: string
}

// ── IPC result shapes (§4.6) — no handler ever echoes a secret value ─────────

export type SetEnabledResult = { ok: true; view: IntegrationView } | { ok: false; reason: string }

export type SetFieldResult = { ok: true; view: IntegrationView } | { ok: false; reason: string }

/** setSecret returns presence-derived status only — the value is inbound-only. */
export type SetSecretResult =
  { ok: true; status: IntegrationStatus } | { ok: false; reason: string }

export type ClearSecretResult = { ok: true; view: IntegrationView } | { ok: false; reason: string }

// ── Canvas transport shape (#3) — a resolved descriptor over IPC ─────────────

/**
 * `status()` is a method on the descriptor (§8), but a method cannot survive
 * structured-clone across the IPC boundary. The renderer therefore receives the
 * descriptor with `status` already RESOLVED to a value at fetch time. Both
 * `flow-palette.ts` and `flow-validate.ts` accept this resolved shape.
 */
export type ResolvedIntegrationDescriptor = Omit<IntegrationDescriptor, 'status'> & {
  status: IntegrationStatus
}

/** Resolve each descriptor's `status()` method to a plain value for transport. */
export function resolveDescriptors(
  descriptors: IntegrationDescriptor[]
): ResolvedIntegrationDescriptor[] {
  return descriptors.map(({ status, ...rest }) => ({ ...rest, status: status() }))
}
