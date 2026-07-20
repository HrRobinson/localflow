import type { IntegrationId } from '../../shared/integrations'
import type { ShortCircuit, WebhookParser, WebhookVerifier } from '../webhooks/webhook-receiver'

/**
 * The `{ verifier, parse, deliver }` lookup the hosted client routes with
 * (design §4.3). Each webhook-capable connector exposes its binding via a small
 * `<connector>WebhookBinding(deliver, opts)` factory beside its existing
 * verifier/parse exports; wiring registers it here keyed by integration id.
 */

/**
 * Everything the hosted client needs to turn a raw delivery for ONE integration
 * into a delivered trigger event. Precisely the transport-independent subset of
 * `WebhookReceiverConfig`, plus the `deliver` sink (what the connector passes to
 * `webhook.onEvent` on the loopback path) and the keychain ref for the signing
 * secret. `E` is the connector's event type.
 */
export interface HostedWebhookBinding<E = unknown> {
  integration: IntegrationId
  verifier: WebhookVerifier
  parse: WebhookParser<E>
  /** Deliver a verified, parsed event to the connector's trigger fan-out. The
   *  SAME function passed to `webhook.onEvent(...)` on the loopback path. May be
   *  async; the client awaits it before acking (at-least-once). */
  deliver: (event: E) => void | Promise<void>
  /** Keychain field name for this integration's webhook signing secret, e.g.
   *  'webhookSecret' / 'webhookClientSecret'. Revealed main-only, per delivery. */
  secretRef: string
  /** The PUBLIC delivered URL for URL-signed schemes (HubSpot v3). Resolved from
   *  the provisioned ingress URL; omitted for body-only schemes. */
  publicUrl?: string
  /** Optional short-circuits carried through unchanged (Woo ping / Shopify
   *  dedup). The hosted path runs them via `handleWebhookDelivery` like HTTP. */
  preVerify?: ShortCircuit
  dedup?: ShortCircuit
  maxBodyBytes?: number
}

/**
 * A lookup the hosted client consults per delivery. Populated at wiring time as
 * each webhook-capable connector is registered — additive, opt-in; a connector
 * with no binding simply can't receive hosted webhooks yet (the client NACKs so a
 * later drain, after wiring, may succeed).
 */
export class WebhookBindingRegistry {
  private readonly bindings = new Map<IntegrationId, HostedWebhookBinding>()

  register<E>(binding: HostedWebhookBinding<E>): void {
    this.bindings.set(binding.integration, binding as HostedWebhookBinding)
  }

  lookup(integration: IntegrationId): HostedWebhookBinding | undefined {
    return this.bindings.get(integration)
  }
}
