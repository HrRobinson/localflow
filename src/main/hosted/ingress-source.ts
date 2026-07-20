import type { IntegrationId } from '../../shared/integrations'

/**
 * The transport seam for hosted webhook ingress (design §4.1). Everything the
 * hosted client pulls from arrives through an `IngressSource` — offline via
 * `MockIngressSource`, live (deferred) via `GcpPubSubIngressSource`. The client
 * itself never imports Pub/Sub; it only sees `Delivery`/`Ack`.
 */

/**
 * One raw webhook the relay published to Pub/Sub, tagged with which connector it
 * belongs to. `rawBody` is the EXACT bytes the vendor sent — verification is over
 * these bytes, so the relay must publish them byte-for-byte (no re-encode). A
 * string is accepted for convenience (the client buffers it before verify).
 * `ingressUrlId` identifies WHICH provisioned ingress URL received it (a tenant
 * may have several; it disambiguates when one integration has multiple URLs).
 */
export interface Delivery {
  integration: IntegrationId
  ingressUrlId: string
  rawBody: Buffer | string
  headers: Record<string, string>
}

/**
 * The client's verdict on one delivery, back to the source. At-least-once:
 *  - 'ack'   — handled (verified+delivered, OR a legible permanent drop: verify-
 *              fail / unparseable — redelivery can't help, so stop redelivering).
 *  - 'nack'  — transient (keychain locked, no connector wired yet, handler threw)
 *              — leave it on the subscription to redeliver later.
 */
export type Ack = 'ack' | 'nack'

/**
 * The transport seam: something that yields deliveries and takes an ack verdict.
 * `drain` registers an async handler and returns an unsubscribe that stops the
 * pull loop. The handler's resolved `Ack` decides ack vs. redeliver; the source
 * only acks the underlying message AFTER the handler resolves (at-least-once —
 * never ack before the local handoff succeeds).
 */
export interface IngressSource {
  drain(handler: (delivery: Delivery) => Promise<Ack>): () => void
}

/**
 * Offline source for tests: replays a fixed list of deliveries and records each
 * one's resolved Ack so a test can assert "ack on verify success, nack on a
 * transient, ack on a permanent drop". No network, no timers.
 */
export class MockIngressSource implements IngressSource {
  /** The Ack the handler returned for each delivered item, in order. */
  readonly acks: { delivery: Delivery; ack: Ack }[] = []
  /** Resolves when the current `drain` replay finishes (test synchronization). */
  settled: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(private readonly deliveries: Delivery[]) {}

  drain(handler: (delivery: Delivery) => Promise<Ack>): () => void {
    this.stopped = false
    this.settled = this.replay(handler)
    return () => {
      this.stopped = true
    }
  }

  /** Replay the whole list and await it — convenience for a deterministic test. */
  async drainOnce(handler: (delivery: Delivery) => Promise<Ack>): Promise<void> {
    this.stopped = false
    await this.replay(handler)
  }

  private async replay(handler: (delivery: Delivery) => Promise<Ack>): Promise<void> {
    for (const delivery of this.deliveries) {
      if (this.stopped) break
      // Await the handoff BEFORE recording the ack — the source never acks
      // before the local handler resolves (at-least-once).
      const ack = await handler(delivery)
      this.acks.push({ delivery, ack })
    }
  }
}

/**
 * DEFERRED — the real Pub/Sub pull via a scoped drain token. Behind the seam
 * exactly like each connector's live transport: constructed with the token +
 * subscription, but the network exit throws a legible "not wired yet" until the
 * follow-up lands (Open decision O-1).
 *
 * The intended live shape (O-1 recommendation) is a REST periodic-pull loop: POST
 * `pull` on the tenant's subscription with the scoped token, hand each message's
 * raw body + attributes to the handler, then `acknowledge` the ackIds the handler
 * resolved 'ack' for (and let the rest redeliver). SDK vs. REST and streaming vs.
 * periodic are O-1; both sit behind this seam so the tested core never changes.
 */
export class GcpPubSubIngressSource implements IngressSource {
  constructor(
    private readonly deps: {
      subscription: string
      /** Mints/refreshes the scoped pull token; NEVER logged. Main-only. */
      token: () => Promise<string>
      log?: (message: string) => void
    }
  ) {}

  drain(_handler: (delivery: Delivery) => Promise<Ack>): () => void {
    void this.deps
    void _handler
    throw new Error(
      'Hosted ingress Pub/Sub transport is not wired yet — the offline ingress core ' +
        '(IngressSource seam, MockIngressSource, the drain client) is in place, but the live ' +
        'Pub/Sub pull lands in a follow-up (design O-1). Use MockIngressSource until then.'
    )
  }
}
