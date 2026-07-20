import type { IntegrationId } from '../../shared/integrations'
import { handleWebhookDelivery, type WebhookReceiverConfig } from '../webhooks/webhook-receiver'
import type { Ack, Delivery, IngressSource } from './ingress-source'
import type { HostedWebhookBinding, WebhookBindingRegistry } from './webhook-bindings'

/**
 * The hosted-ingress client (design §4.2, §5). Drains ONE source and, for each
 * delivery: looks up the connector binding by `delivery.integration`, reveals
 * that integration's webhook secret from the keychain, runs the SHARED
 * `handleWebhookDelivery` verify+parse core, and on a 200-with-event awaits the
 * connector's `deliver` before returning `ack`.
 *
 * Never throws out of the handler — the whole per-delivery path is guarded so one
 * bad delivery can never wedge the drain loop. Ack semantics (§5.2):
 *  - verify-fail (401) / parse-fail (400)  → ack-drop  (redelivery can't help)
 *  - preVerify / dedup short-circuit (200) → ack       (acknowledged, nothing to run)
 *  - delivered (200 + event)               → ack       (flow seeded)
 *  - no binding / reveal throws / deliver threw → nack  (transient; redeliver later)
 */
export class HostedIngressClient {
  private readonly registry: WebhookBindingRegistry
  private readonly reveal: (integration: IntegrationId, secretRef: string) => string
  private readonly log: (message: string) => void
  private stop: (() => void) | null = null

  constructor(deps: {
    registry: WebhookBindingRegistry
    /** Main-only keychain reveal for a connector's webhook signing secret (the
     *  `CredentialStore` plaintext exit, injected so this file never names it). */
    reveal: (integration: IntegrationId, secretRef: string) => string
    log?: (message: string) => void
  }) {
    this.registry = deps.registry
    this.reveal = deps.reveal
    this.log = deps.log ?? ((m) => console.warn(m))
  }

  /** Begin draining `source`; returns a stop() that unsubscribes. Idempotent —
   *  a second start() while already draining returns the existing stop. */
  start(source: IngressSource): () => void {
    if (this.stop) return this.stop
    const unsubscribe = source.drain((delivery) => this.handle(delivery))
    this.stop = () => {
      unsubscribe()
      this.stop = null
    }
    return this.stop
  }

  /** The per-delivery decision table (§5.2). Always resolves — never rejects. */
  private async handle(delivery: Delivery): Promise<Ack> {
    const route = `hosted ${delivery.integration}/${delivery.ingressUrlId}`

    const binding = this.registry.lookup(delivery.integration)
    if (!binding) {
      this.log(
        `hosted ingress: no connector is wired for '${delivery.integration}' — enable it in ` +
          `Integrations, then this webhook will be delivered on the next drain.`
      )
      return 'nack'
    }

    // Reveal the signing secret main-only, per delivery, never retained. A locked
    // keychain (safeStorage unavailable) surfaces CredentialStore's own legible
    // message and is transient → nack.
    let secret: string
    try {
      secret = this.reveal(delivery.integration, binding.secretRef)
    } catch (err) {
      this.log(`hosted ingress ${route}: ${errText(err)}`)
      return 'nack'
    }

    const rawBody = Buffer.isBuffer(delivery.rawBody)
      ? delivery.rawBody
      : Buffer.from(delivery.rawBody)

    // The URL a URL-signed scheme (HubSpot v3) verifies against: prefer the
    // per-delivery `publicUrl` the relay stamped (so a tenant with several
    // HubSpot URLs verifies each delivery against the URL it actually arrived
    // on), falling back to the binding's static `publicUrl`.
    const publicUrl = delivery.publicUrl ?? binding.publicUrl

    const config: WebhookReceiverConfig<unknown> = {
      path: route,
      verifier: binding.verifier,
      parse: binding.parse,
      secret,
      log: this.log,
      ...(publicUrl !== undefined ? { publicUrl } : {}),
      ...(binding.preVerify ? { preVerify: binding.preVerify } : {}),
      ...(binding.dedup ? { dedup: binding.dedup } : {}),
      ...(binding.maxBodyBytes !== undefined ? { maxBodyBytes: binding.maxBodyBytes } : {})
    }

    const out = handleWebhookDelivery(config, {
      rawBody,
      headers: delivery.headers,
      ...(publicUrl !== undefined ? { publicUrl } : {})
    })

    // Permanent failures ack-drop so a bad message doesn't wedge the subscription
    // (§5.2). handleWebhookDelivery already logged the route + reason.
    if (out.status === 401 || out.status === 400) return 'ack'

    // A 200 short-circuit (preVerify / dedup) carries no event — ack, nothing to run.
    if (out.event === undefined) return 'ack'

    // Deliver to the connector's trigger fan-out. A throw here is a transient
    // flow-engine handoff failure → nack (redeliver); it never crashes the loop.
    try {
      await (binding as HostedWebhookBinding).deliver(out.event)
    } catch (err) {
      this.log(
        `hosted ingress ${route}: delivery to the flow engine failed — ${errText(err)}; ` +
          `it will be retried.`
      )
      return 'nack'
    }
    return 'ack'
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
