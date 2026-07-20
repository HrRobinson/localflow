# Hosted-ingress client — design spec

- **Status:** draft (design only — no implementation code, no PR)
- **Date:** 2026-07-20
- **Branch:** `build/hosted-ingress-client`
- **Related:** `2026-07-18-connector-shared-infra-design.md` (the shared
  `webhook-receiver.ts` this refactors), `2026-07-18-hubspot-connector-design.md`
  (the `publicUrl` URL-signed scheme), `2026-07-16-integrations-hub-design.md`
  (`LiveConnector` / registry seam), `2026-07-16-flow-engine-design.md`
  (trigger fan-out).

---

## 1. Goal & scope

localflow's webhook connectors (Shopify, Stripe, HubSpot, GitHub, GitLab,
Sentry, Woo, Linear, …) can only receive a vendor webhook when the machine has a
**public URL**. Today every one of them binds a **loopback** HTTP server
(`startWebhookReceiver`, `host: '127.0.0.1'`) and every wiring comment in
`src/main/index.ts` says the same thing: *"No webhook server is started (cloud
ingress deferred); trigger subscriptions register but stay dormant."* A laptop
behind NAT with no inbound port simply cannot be a webhook target — the entire
trigger half of every connector is dark for the typical user.

**This spec designs the OSS half of the paid hosted-webhook-ingress feature: a
thin client, in the open-source localflow app, that PULLS webhooks from a hosted
relay instead of receiving them over an inbound HTTP port.** The relay
(closed-source, separate private repo — **not designed here**) is a dumb pipe:
vendor → relay POSTs to a per-tenant unguessable URL → relay publishes the RAW
body + headers to a per-tenant Pub/Sub topic. The local app drains its Pub/Sub
subscription via a **scoped pull token**, feeds each raw delivery into the
**existing** verify-before-parse pipeline (HMAC verified against the **keychain**
secret, locally), and only then acks. Offline → Pub/Sub buffers → replays on
reconnect.

**The load-bearing invariant: data, credentials, verification, and all actions
stay LOCAL.** The relay never holds a signing secret, never verifies a
signature, never parses a body's meaning, and never runs a flow action. It moves
opaque bytes. Verification happens on the user's machine with a secret that never
leaves the keychain. This is what makes a paid hosted relay acceptable in an
otherwise local-first, privacy-first app.

### 1.1 MVP scope (offline-testable core; live wiring deferred)

Mirroring how every connector shipped its offline core first (descriptor +
verifier + parse + dispatch, mock-tested, with the live transport a loud
deferred stub), the MVP is:

**In scope (offline, fully tested):**

1. The `handleWebhookDelivery` **refactor** — extract a transport-agnostic
   verify→dedup→parse→deliver core from `startWebhookReceiver`; the existing HTTP
   receiver calls it; every existing webhook test stays green (§3).
2. `IngressSource` seam + a **`MockIngressSource`** that replays canned
   deliveries offline, with at-least-once ack semantics (§4.1, §5.1).
3. `HostedIngressClient` — drains a source, routes each delivery to the right
   connector's `{ verifier, parse, deliver }`, calls `handleWebhookDelivery`,
   acks on success / nacks on transient failure / drops on permanent failure
   (§5.2).
4. The **webhook-binding registry** — the seam by which each connector exposes
   `{ verifier, parse, deliver }` keyed by integration id, so the client can look
   one up by an incoming delivery's `integration` tag (§4.3).
5. `HostedControlApi` seam + a **`MockControlApi`** (provision/list ingress URLs,
   mint a scoped drain token) with all relay wire-shapes isolated behind it
   (§5.3).
6. `hosted-config.ts` — validate-at-boundary config; the account token in the
   keychain, non-secret refs in config.json (§5.4).
7. Settings surface **design** (§8) — not built here, pinned for the renderer.

**Deferred (behind the seam, exactly like the connectors' live transports):**

- **`GcpPubSubIngressSource`** — the real Pub/Sub pull (SDK or REST) via the
  scoped token. The seam is designed and mock-tested; the live network exit lands
  in a follow-up (Open decision O-1).
- **`HttpControlApi`** — the real HTTP client to the relay's control API. The
  relay is a separate private repo; until its API is frozen, the live client is a
  loud deferred stub and `MockControlApi` drives every test (Open decision O-3).
- The relay itself (Cloud Run pipe, Pub/Sub topics, per-tenant URL minting) —
  **entirely out of scope; different repo.**

### 1.2 What this is NOT

Not a new connector, not a new verifier scheme, not a change to any vendor's
parse or normalize. The hosted client is a **new transport** that feeds the
**existing** connector pipeline. A webhook that arrives via the relay is verified
and delivered by *exactly the same code* as one that arrived over loopback HTTP —
the only difference is where the raw bytes came from. It is also not an outbound
feature: the client only ever PULLS; it never exposes an inbound port.

---

## 2. The refactor: extract `handleWebhookDelivery` (behavior-preserving)

### 2.1 The problem

`src/main/webhooks/webhook-receiver.ts` couples the security-critical
verify→dedup→parse→deliver **logic** to a `node:http` server.
`startWebhookReceiver` (L274–393) does two jobs braided together:

- **Transport:** `createServer`, loopback bind, ephemeral port, the `responded`
  latch + mid-body `'error'` guard, the `MAX_BODY_BYTES` cap → 413 + `destroy()`,
  reading the body off the socket, writing HTTP status codes, the `port`/`close()`
  handle.
- **Policy (transport-agnostic):** `preVerify?` → `verifyWebhookSignature` over
  the RAW body BEFORE parse → `dedup?` → `parse` → 200-fast +
  `setImmediate(deliver)`, with route+reason logging that never touches the
  secret or body.

The hosted drainer needs to run the **policy** on a payload that arrives as an
already-buffered `rawBody` + `headers` from Pub/Sub — there is no socket, no
port, no chunked body to cap, no `req.destroy()`. It must NOT re-implement the
verify/dedup/parse ordering (that is the security-critical part), and the
existing HTTP path must keep behaving byte-for-byte identically.

### 2.2 The seam

Extract a pure function that takes an already-collected raw body + headers and
returns a **status + optional event**, with no `node:http` types in its
signature:

```ts
// src/main/webhooks/webhook-receiver.ts (new export; same file)

/** The outcome of running the verify→dedup→parse policy on one delivery.
 *  `status` is the SAME numeric code the HTTP server would have written, so the
 *  HTTP path maps it straight to `res.writeHead(status)` and the hosted path maps
 *  it to ack/nack. `event` is present ONLY on a 200 that produced an event to
 *  deliver (a 200 short-circuit — Woo ping / Shopify dedup-drop — carries none). */
export interface DeliveryOutcome<E> {
  status: 200 | 400 | 401
  /** The parsed event to deliver, or undefined for a short-circuit 200. */
  event?: E
  /** A stable machine reason for logging/metrics — never the secret or body. */
  reason:
    | 'delivered'
    | 'pre-verify-short-circuit'
    | 'verify-failed'
    | 'duplicate'
    | 'unparseable'
}

/** Inputs the policy needs, transport-agnostic. `rawBody` is ALREADY collected
 *  (the caller owns size limiting: the HTTP server via its 413 cap, the hosted
 *  source via the relay's body ceiling). `publicUrl` is the PUBLIC delivered URL
 *  a `baseString` composer signs (HubSpot); it defaults to the config path. */
export interface DeliveryInput {
  rawBody: Buffer
  headers: IncomingHttpHeaders
  method?: string
  /** The PUBLIC URL the vendor delivered to (HubSpot v3 signs it). */
  publicUrl?: string
}

/**
 * Run the transport-agnostic verify→dedup→parse policy for one delivery. This is
 * the security-critical core, lifted VERBATIM from `startWebhookReceiver`'s
 * `req.on('end')` handler (steps 3–6): preVerify → verify-over-raw-body →
 * dedup → parse. It does NOT deliver — the caller decides how to deliver on a
 * `status: 200` with an `event` (the HTTP path `setImmediate`s it after writing
 * 200; the hosted path awaits the handler before acking).
 *
 * Every invariant is preserved because the SAME lines move here unchanged:
 * empty-secret rejection, timing-safe compare, verify-before-parse, the
 * preVerify/dedup ordering, and the log callback never seeing the secret/body.
 */
export function handleWebhookDelivery<E>(
  config: WebhookReceiverConfig<E>,
  input: DeliveryInput
): DeliveryOutcome<E>
```

**Exactly which lines move.** The body of `req.on('end')` in
`startWebhookReceiver` (`webhook-receiver.ts:312–377`) splits at the `res`
writes:

- **Moves into `handleWebhookDelivery` verbatim (policy):** the `preVerify`
  short-circuit (L318–326), `verifyWebhookSignature(rawBody, headers, verifier,
  secret, Date.now, { method, requestUri: publicUrl ?? … })` (L331–341), the
  `dedup` short-circuit (L345–353), and `config.parse(rawBody, headers)` →
  null-check (L355–361). Each `res.writeHead(code); res.end(); log(…)` pair
  becomes a `return { status, reason }` — the log strings are preserved
  **verbatim in wording** so the "never logs the secret/body" tests keep passing.
- **Stays in `startWebhookReceiver` (transport):** everything through collecting
  the body (L283–315: `createServer`, method/path 404, the `responded` latch, the
  413 cap, `req.destroy()`), plus the 200-fast + `setImmediate(deliver)` tail
  (L363–376). The tail becomes: call `handleWebhookDelivery`, `res.writeHead(out.
  status); res.end()`, then if `out.status === 200 && out.event`
  `setImmediate(() => deliver(out.event!))` inside the same try/catch.

**Ordering is pinned and unchanged** — the four short-circuits keep firing in the
same order with the same codes:

1. (HTTP-only, stays in the server) method/path → 404; body over cap → 413.
2. `preVerify?` → `200` short-circuit (`reason: 'pre-verify-short-circuit'`).
3. `verifyWebhookSignature` over raw body → `401` on fail (`'verify-failed'`).
4. `dedup?` → `200` short-circuit (`'duplicate'`).
5. `parse` → `null` ⇒ `400` (`'unparseable'`); else `200` + `event`
   (`'delivered'`).

The 404/413 codes never come out of `handleWebhookDelivery` — they are transport
concerns (there is no "wrong path" or "socket cap" for a Pub/Sub message; the
relay only ever publishes to the right tenant's topic, and body size is bounded
by the relay's own ceiling before publish). `DeliveryOutcome.status` is therefore
narrowed to `200 | 400 | 401`.

### 2.3 Why this is behavior-preserving

The HTTP server's observable behavior is unchanged because the moved lines are
identical and the ordering is identical — `startWebhookReceiver` just calls the
extracted function instead of inlining it, and maps the returned `status` to the
`res.writeHead` it used to write inline. The existing suites are the regression
gate: `shopify-webhook-server.test.ts`, `stripe-webhook-server.test.ts`,
`hubspot`/`gitlab`/`github`/`sentry`/`linear`/`wc-webhook-server.test.ts`, and the
receiver matrix `webhook-receiver.test.ts` all stay green with **no behavioral
edits** (§7). `verifyWebhookSignature` is untouched — `handleWebhookDelivery`
calls it exactly as the server did.

---

## 3. Architecture (modules + paths)

All new code lives under `src/main/hosted/`. Nothing in `src/main/integrations/*`
or the connectors changes except the additive binding registration (§4.3) and the
one-line refactor call-site in `webhook-receiver.ts` (§2).

```
src/main/hosted/
  ingress-source.ts        §4.1  IngressSource seam + Delivery/Ack types;
                                 MockIngressSource (offline). GcpPubSubIngressSource
                                 = deferred stub behind the seam.
  hosted-ingress.ts        §4.2  HostedIngressClient — drain → route → verify-local
                                 → deliver → ack. The heart of the feature.
  webhook-bindings.ts      §4.3  HostedWebhookBinding + WebhookBindingRegistry —
                                 the { verifier, parse, deliver } lookup by
                                 integration id the client routes with.
  hosted-control-client.ts §4.4  HostedControlApi seam (provision/list URLs, mint
                                 drain token); MockControlApi. HttpControlApi =
                                 deferred stub.
  hosted-config.ts         §4.5  validate-at-boundary config (base URL, enabled,
                                 non-secret refs); keychain for the account token.

src/main/webhooks/
  webhook-receiver.ts      §2    + handleWebhookDelivery / DeliveryInput /
                                 DeliveryOutcome (refactor). startWebhookReceiver
                                 now calls it. Behavior-preserving.
```

Two seams keep the network out of the tested core, matching the connector
pattern:

- **`IngressSource`** isolates *where deliveries come from* (mock vs. Pub/Sub).
- **`HostedControlApi`** isolates *the relay's control-plane wire shapes* (mock
  vs. HTTP).

Everything between — routing, verify, deliver, ack decisioning — is pure enough
to test offline against the mocks.

### 3.1 Data flow (happy path)

```
vendor  ──HTTPS POST──▶  relay (Cloud Run, separate repo)
                          │ per-tenant unguessable URL
                          ▼
                        relay publishes { rawBody, headers, integration,
                          ingressUrlId } to per-tenant Pub/Sub topic
                          ▼  (buffers while the app is offline)
┌──────────────────────── LOCAL APP (this spec) ───────────────────────────────┐
│ IngressSource.drain(handler)                                                   │
│   └─ pulls a Delivery = { integration, ingressUrlId, rawBody, headers }        │
│        ▼                                                                        │
│ HostedIngressClient                                                            │
│   ├─ registry.lookup(delivery.integration) → { verifier, parse, deliver,       │
│   │                                            secretRef, publicUrl }           │
│   ├─ secret = creds.revealForConnector(integration, secretRef)  (keychain)     │
│   ├─ out = handleWebhookDelivery({ verifier, parse, secret, publicUrl, … },    │
│   │          { rawBody, headers, publicUrl })         ← SAME verify+parse core  │
│   ├─ out.status 200 + event → await deliver(event)    → trigger fan-out        │
│   │                                                     (connector.onDelivery)  │
│   └─ decide Ack (§5)                                                            │
│        ▼                                                                        │
│ IngressSource ack/nack → relay drops (ack) or redelivers (nack)                │
└────────────────────────────────────────────────────────────────────────────────┘
```

The `deliver` step is the connector's existing delivery sink — the same function
that today is passed to `webhook.onEvent(...)` (e.g. Shopify's `onDelivery` →
`webhookToPayload` → `triggersForTopic` → the flow-engine handlers). The hosted
path produces **the identical `SeedEvent`** that a loopback delivery would, so
`trigger-subscriber.ts` fan-out, filters, and run seeding are unchanged.

---

## 4. Pinned contracts (verbatim types)

### 4.1 `src/main/hosted/ingress-source.ts`

```ts
import type { IncomingHttpHeaders } from 'node:http'
import type { IntegrationId } from '../../shared/integrations'

/**
 * One raw webhook the relay published to Pub/Sub, tagged with which connector it
 * belongs to. `rawBody` is the EXACT bytes the vendor sent — verification is
 * over these bytes, so the relay must publish them byte-for-byte (no re-encode).
 * `ingressUrlId` identifies WHICH provisioned ingress URL received it (a tenant
 * may have several; it disambiguates when one integration has multiple URLs).
 */
export interface Delivery {
  integration: IntegrationId
  ingressUrlId: string
  rawBody: Buffer
  headers: IncomingHttpHeaders
}

/** The client's verdict on one delivery, back to the source. At-least-once:
 *  - 'ack'   — handled (verified+delivered, OR a legible permanent drop: verify
 *              -fail / unparseable — redelivery can't help, so stop redelivering).
 *  - 'nack'  — transient (keychain locked, no connector wired yet, handler threw)
 *              — leave it on the subscription to redeliver later. */
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
  constructor(deliveries: Delivery[])
  /** The Ack the handler returned for each delivered item, in order. */
  readonly acks: { delivery: Delivery; ack: Ack }[]
  drain(handler: (delivery: Delivery) => Promise<Ack>): () => void
}

/**
 * DEFERRED — the real Pub/Sub pull via a scoped drain token. Behind the seam
 * exactly like each connector's live transport: constructed with the token +
 * subscription, but the network exit throws a legible "hosted ingress Pub/Sub
 * transport is not wired yet" until the follow-up lands (Open decision O-1).
 * Streaming-pull vs. periodic pull, and SDK vs. REST, are O-1.
 */
export class GcpPubSubIngressSource implements IngressSource {
  constructor(deps: {
    subscription: string
    /** Mints/refreshes the scoped pull token; NEVER logged. Main-only. */
    token: () => Promise<string>
    log?: (message: string) => void
  })
  drain(handler: (delivery: Delivery) => Promise<Ack>): () => void
}
```

### 4.2 `src/main/hosted/hosted-ingress.ts`

```ts
import type { IngressSource, Ack, Delivery } from './ingress-source'
import type { WebhookBindingRegistry } from './webhook-bindings'
import { handleWebhookDelivery } from '../webhooks/webhook-receiver'

/**
 * The hosted-ingress client. Drains ONE source, and for each delivery: looks up
 * the connector binding by `delivery.integration`, reveals that integration's
 * webhook secret from the keychain, runs the SHARED `handleWebhookDelivery`
 * verify+parse core, and on a 200-with-event awaits the connector's `deliver`
 * before returning `ack`. Never throws out of the handler — a verify-fail or
 * parse-fail is a legible ACK-drop (redelivery won't help); a transient (no
 * binding, keychain locked, deliver threw) is a NACK (redeliver later).
 */
export class HostedIngressClient {
  constructor(deps: {
    registry: WebhookBindingRegistry
    /** Main-only keychain reveal (CredentialStore.revealForConnector). */
    reveal: (integration: IntegrationId, secretRef: string) => string
    log?: (message: string) => void
  })

  /** Begin draining `source`; returns a stop() that unsubscribes. Idempotent. */
  start(source: IngressSource): () => void
}
```

The per-delivery handler is the whole feature; its decision table is §5. It maps
a `Delivery` to a `WebhookReceiverConfig` on the fly from the binding
(`{ verifier, parse, secret, publicUrl, dedup, preVerify }`) and hands it to
`handleWebhookDelivery`. Note `secret` is revealed **per delivery** and never
retained — matching `revealForConnector`'s main-only, no-cache discipline.

### 4.3 `src/main/hosted/webhook-bindings.ts` — the `{verifier, parse, deliver}` registry

The connectors ALREADY hold `verifier`, `parse`, and a delivery sink — they are
just wired to an HTTP server today. Shopify's binding lives across
`shopify-webhook-server.ts` (`SHOPIFY_VERIFIER`, `parseShopifyDelivery`,
`makeShopifyDedup`) and `shopify-connector.ts` (`onDelivery`, reached via
`webhook.onEvent`). The seam collects those into one record keyed by integration
id:

```ts
import type { IntegrationId } from '../../shared/integrations'
import type {
  WebhookVerifier,
  WebhookParser,
  ShortCircuit
} from '../webhooks/webhook-receiver'

/**
 * Everything the hosted client needs to turn a raw delivery for ONE integration
 * into a delivered trigger event. This is precisely the subset of
 * `WebhookReceiverConfig` that is transport-independent, plus the `deliver`
 * sink (what the connector today passes to `webhook.onEvent`) and the keychain
 * ref for the signing secret. `E` is the connector's event type.
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
   *  'webhookSecret' / 'clientSecret'. Revealed main-only, per delivery. */
  secretRef: string
  /** The PUBLIC delivered URL for URL-signed schemes (HubSpot v3). Resolved from
   *  the provisioned ingress URL for this integration; omitted for body-only
   *  schemes. */
  publicUrl?: string
  /** Optional short-circuits, carried through unchanged (Woo ping / Shopify
   *  dedup). The hosted path runs them via `handleWebhookDelivery` just like HTTP. */
  preVerify?: ShortCircuit
  dedup?: ShortCircuit
  maxBodyBytes?: number
}

/** A lookup the hosted client consults per delivery. Populated at wiring time in
 *  index.ts as each webhook-capable connector is registered — additive, opt-in;
 *  a connector with no binding simply can't receive hosted webhooks yet. */
export class WebhookBindingRegistry {
  register<E>(binding: HostedWebhookBinding<E>): void
  /** The binding for an integration, or undefined (⇒ the client NACKs with a
   *  legible "no hosted binding for <id>" — redelivery may succeed after wiring). */
  lookup(integration: IntegrationId): HostedWebhookBinding | undefined
}
```

**How a connector exposes its binding (the proposed seam).** Two options, flagged
as Open decision O-2; the recommended one:

- Each webhook connector's `*-webhook-server.ts` already exports its `verifier`
  and `parse` (e.g. `SHOPIFY_VERIFIER`, `parseShopifyDelivery`;
  `HUBSPOT_VERIFIER`, `parseHubSpotBatch`). Add a small
  `<connector>WebhookBinding(deliver, opts)` factory next to them that returns a
  `HostedWebhookBinding` wiring those exports to the connector's delivery sink.
  The `deliver` passed in is the connector's existing per-event handler (Shopify:
  `(d) => connector.onDelivery(d)` — the same callback `wireWebhook()` gives to
  `onEvent`). Wiring in `index.ts` calls the factory and `registry.register(...)`
  right where the connector is registered today.

This keeps the binding definition **beside the verifier/parse it already owns**,
adds no new abstraction to `LiveConnector`, and means "make connector X
hosted-capable" is one factory + one `register` line — no new security code.

### 4.4 `src/main/hosted/hosted-control-client.ts`

```ts
/**
 * The thin client to the relay's CONTROL API (provision/list ingress URLs, mint
 * a scoped drain token). ALL relay wire-shapes are isolated in this file so the
 * rest of the app never imports a relay type. Auth is the ACCOUNT TOKEN (keychain,
 * main-only, never logged). The live HTTP client is DEFERRED — the relay is a
 * separate private repo whose API isn't frozen — so `MockControlApi` drives every
 * test and `HttpControlApi` is a loud stub until the API lands (Open decision O-3).
 */

/** A provisioned ingress URL the user pastes into a vendor's webhook settings. */
export interface IngressUrl {
  id: string                 // == Delivery.ingressUrlId
  integration: IntegrationId
  /** The public URL the vendor delivers to (also the `publicUrl` for URL-signed
   *  schemes). Unguessable per-tenant path; NOT a secret in the keychain sense,
   *  but treated as capability-bearing (a non-secret ref in config is fine). */
  url: string
  createdAt: string
}

/** The scoped, short-lived credential the IngressSource uses to PULL Pub/Sub.
 *  Scoped to this tenant's subscription only; NEVER logged; refreshed via the
 *  control API. Held in memory only for the drain loop's lifetime. */
export interface DrainToken {
  token: string
  subscription: string
  expiresAt: string
}

export interface HostedControlApi {
  /** List the tenant's provisioned ingress URLs. */
  listIngressUrls(): Promise<IngressUrl[]>
  /** Provision a new ingress URL for an integration; returns the pasteable URL. */
  provisionIngressUrl(integration: IntegrationId): Promise<IngressUrl>
  /** Mint/refresh the scoped Pub/Sub pull token. */
  mintDrainToken(): Promise<DrainToken>
}

/** Offline control API for tests: canned URLs + a fake token. No network. */
export class MockControlApi implements HostedControlApi { /* … */ }

/** DEFERRED live client. Constructed with the account-token reveal + base URL;
 *  every method throws a legible "hosted control API is not wired yet" until the
 *  relay's API is frozen (Open decision O-3). */
export class HttpControlApi implements HostedControlApi {
  constructor(deps: {
    baseUrl: string
    /** Account-token reveal (keychain, main-only). NEVER logged. */
    accountToken: () => string
    log?: (message: string) => void
  })
}
```

### 4.5 `src/main/hosted/hosted-config.ts`

```ts
/**
 * Validate-at-the-boundary config for hosted ingress, mirroring the connectors'
 * config shape: NON-SECRET refs live in config.json under a `hosted` key; the
 * ACCOUNT TOKEN is a secret and lives ONLY in the keychain (never config.json,
 * never logged). A hand-edited token in config.json is dropped with a legible
 * notice, exactly like the integrations config-boundary notice.
 */
export interface HostedConfig {
  /** Master switch. When false, the client never drains (opt-in default). */
  enabled: boolean
  /** The relay control-API base URL (https-only; validated here). */
  controlApiBaseUrl: string
  /** Cached non-secret refs so the UI can render provisioned URLs without a
   *  round-trip; the control API is the source of truth. */
  ingressUrls?: IngressUrl[]
}

/** Parse + validate the `hosted` config entry; returns a legible rejection for a
 *  non-https base URL / malformed shape rather than throwing. */
export function parseHostedConfig(raw: unknown): HostedConfig | { error: string }
```

The account token is stored via `CredentialStore` under a reserved
pseudo-integration key (Open decision O-4 covers whether `IntegrationId` gains a
`'hosted'` member or the token gets its own tiny store like
`hubspot-token-store.ts`).

---

## 5. Data flow & ack semantics (at-least-once)

### 5.1 At-least-once contract

Pub/Sub redelivers any message not acked within its deadline, and buffers while
the app is offline. The client therefore MUST NOT ack until the local handoff has
a definitive outcome, and MUST tolerate **duplicate** deliveries. Duplicates ride
the connectors' **existing dedup** — Shopify's `X-Shopify-Webhook-Id` seen-set
(`makeShopifyDedup`) and any future `dedupHeader` — which `handleWebhookDelivery`
runs identically to the HTTP path. So a redelivered Shopify order is verified,
seen as a duplicate, and dropped with a 200 (`reason: 'duplicate'`) → the client
acks it. Offline buffering + replay is entirely the relay/Pub/Sub's job; the
client just drains whatever is queued when it reconnects.

### 5.2 The per-delivery decision table

| Situation | `handleWebhookDelivery` | Client verdict | Why |
|---|---|---|---|
| Verified + parsed, `deliver` resolves | `200`, `'delivered'` | **ack** | Done — flow seeded. |
| `preVerify` short-circuit (Woo ping) | `200`, `'pre-verify-short-circuit'` | **ack** | Acknowledged, nothing to run. |
| Dedup drop (redelivery) | `200`, `'duplicate'` | **ack** | Already handled; stop redelivering. |
| Signature fails | `401`, `'verify-failed'` | **ack (drop)** | Redelivery of the same bytes can't verify differently — a forged/misconfigured delivery. Log loudly; don't loop forever. |
| Unparseable / unsupported | `400`, `'unparseable'` | **ack (drop)** | Same body will never parse; drop with a legible log. |
| No binding for `integration` | — | **nack** | Connector not wired/enabled yet — a later drain (after enable) may succeed. |
| Keychain locked / reveal throws | — | **nack** | Transient (safeStorage unavailable) — retry when unlocked. |
| `deliver` throws | — (200 reached, delivery failed) | **nack** | The flow-engine handoff failed transiently; redeliver. |

The distinction that matters: **permanent** failures (verify-fail, parse-fail)
ack-drop so a bad message doesn't wedge the subscription; **transient** failures
(not-yet-wired, locked keychain, handler throw) nack so Pub/Sub redelivers. This
is the honest reading of at-least-once — never silently lose a good webhook, never
infinitely redeliver a bad one.

### 5.3 Offline → reconnect

No client-side buffering is designed — that is Pub/Sub's role by construction. On
reconnect the `IngressSource` simply resumes pulling; the backlog drains oldest-
first through the same per-delivery path. The MVP's `MockIngressSource` models
this as "hand the client a list that includes what queued while 'offline'."

---

## 6. Auth & keychain

Two distinct secrets, both keychain-resident and main-only, never rendered:

1. **The account token** — authenticates the local app to the relay's *control*
   API (§4.4). Long-lived, user-pasted in the Settings surface (§8), stored via
   `CredentialStore` (safeStorage). It is the "who is this tenant" credential. It
   authorizes provisioning URLs and minting drain tokens. Per the global secret
   rules and `error-message-style`: never in argv, never logged, never echoed
   back over IPC (the Settings DTO carries a `hasValue` boolean only, exactly like
   every integration secret).
2. **The scoped drain token** — a short-lived, narrowly-scoped credential the
   `IngressSource` uses to PULL the tenant's Pub/Sub subscription and nothing else
   (§4.4 `DrainToken`). Minted by the control API using the account token; held in
   memory only for the drain loop; refreshed before expiry; never persisted, never
   logged.

3. **The webhook signing secrets** — UNCHANGED. Each connector's HMAC/app secret
   already lives in the keychain and is revealed main-only via
   `CredentialStore.revealForConnector` *per delivery* inside the client (§4.2).
   The relay never sees these — this is the whole privacy argument.

The account token → drain token → Pub/Sub pull chain means the relay never holds
a Google service-account key on the client's behalf either; the client presents a
scoped token it was granted, matching this user's "prove state, never render
value; scoped tokens over broad ones" posture.

---

## 7. Error handling (all legible, per `error-message-style`)

Every failure carries the real cause, human language, and an action — no bare
"not found / no connection":

- **Verify-fail** (`401`): logged as
  `"hosted ingress <integration>/<ingressUrlId>: rejected — signature verification failed"`
  — route + reason only, NEVER the secret, body, or signature (identical wording
  discipline to `webhook-receiver.ts`'s existing log so the "never logs the
  secret" tests transfer). Ack-drops (§5.2).
- **Parse-fail** (`400`): `"… rejected — unsupported or malformed payload"`.
  Ack-drops.
- **No binding**: `"hosted ingress: no connector is wired for '<integration>' —
  enable it in Integrations, then this webhook will be delivered on the next
  drain."` NACK (transient).
- **Keychain locked / reveal throws**: surfaces `CredentialStore`'s own legible
  message (`"Stored '<id>' credential '<key>' can't be decrypted (safeStorage: …)
  — re-enter it in the Integrations tab."`). NACK.
- **`deliver` throws**: `"hosted ingress <integration>: delivery to the flow
  engine failed — <cause>; it will be retried."` NACK; never crashes the drain
  loop (the whole handler is try/caught, mirroring the HTTP path's
  `setImmediate` try/catch).
- **Drain error** (source-level, e.g. the pull stream drops): logged as
  `"hosted ingress: the pull connection dropped (<cause>) — reconnecting."`; the
  source retries with backoff. A single delivery's failure NEVER tears down the
  loop.
- **Control-API auth error**: `"The hosted account token was rejected by the
  relay (<status>) — re-enter it in Settings › Hosted ingress."` Surfaced in the
  Settings surface, not a silent disable.

The account/drain tokens and every webhook secret flow ONLY through the main-only
keychain reveal and are never logged, echoed, or placed in argv (global secret
rules).

---

## 8. Settings surface (design only)

A "Connect hosted ingress" panel in `Settings.tsx` (card style already in that
file), designed here, built in a follow-up. State machine:

1. **Disconnected** — a short explainer ("Receive webhooks without a public URL.
   Your webhook secrets and data stay on this machine; the relay only forwards
   encrypted bytes.") + a masked **account token** field (paste-only; renders
   `hasValue`, never the value) + a **Connect** button. An **Enable hosted
   ingress** toggle (the `enabled` flag) is disabled until a token is present.
2. **Connected** — a **provisioned ingress URLs** list: per integration, the
   pasteable `url` with a copy button and a "paste this into <vendor>'s webhook
   settings" hint, plus **Provision URL** (calls
   `control.provisionIngressUrl(integration)`). A **connection status** line
   (draining / reconnecting / auth error) driven by the client's state.
3. **Error** — the control-API auth error (§7) inline, with a re-enter-token
   action.

The panel NEVER shows a token value, a drain token, or a webhook secret — only
presence, provisioned URLs (non-secret refs), and status. This mirrors the
existing integrations Settings DTO exactly.

---

## 9. Testing

**Regression gate (the refactor).** The whole point of §2 is that this stays
green with zero behavioral edits: `webhook-receiver.test.ts` (the scheme matrix),
and every connector receiver test — `shopify-`, `stripe-`, `hubspot-`, `gitlab-`,
`github-`, `sentry-`, `linear-`, `wc-webhook-server.test.ts` — including the
"never logs the secret", "200s a Woo ping WITHOUT spawning a run", HubSpot's
`publicUrl`-signed cases, and Stripe's replay-window cases. Run `npm test`
(vitest) + `npm run typecheck` as the gate. A new `webhook-receiver.test.ts`
addition drives `handleWebhookDelivery` directly (all five outcomes) to lock the
extracted core independently of the HTTP server.

**New — hosted client (offline, mocks only).** `hosted-ingress.test.ts` drives
`HostedIngressClient` with a `MockIngressSource` + a `WebhookBindingRegistry`
holding a real connector binding (Shopify is the acid test — base64 HMAC + dedup;
HubSpot for the `publicUrl` URL-signed path) and a fake keychain reveal:

- Valid signature → verified, `deliver` called with the same `SeedEvent` the
  loopback path produces → `acks` records `'ack'`.
- Forged signature → `'verify-failed'` → `'ack'` (drop), and the spy proves the
  secret/body were never logged.
- Redelivered Shopify id → dedup drop → `'ack'`.
- Unknown integration → `'nack'`.
- `reveal` throws (locked keychain) → `'nack'`.
- `deliver` throws → `'nack'`, loop survives, next delivery still processed.
- HubSpot delivery with the binding's `publicUrl` → verifies (proves the URL-
  signed scheme is threaded through `handleWebhookDelivery` from the hosted path).

**New — control client / config.** `hosted-control-client.test.ts` drives
`MockControlApi` (provision → list round-trips, mint token shape) and asserts a
token value never appears in any log. `hosted-config.test.ts` covers the https-
only base-URL validation, the hand-edited-token-in-config.json drop notice, and
the `enabled`-off → never-drains default.

The `GcpPubSubIngressSource` and `HttpControlApi` deferred stubs get a single
"throws a legible not-wired-yet error" test each, matching how every connector's
deferred live transport is covered.

---

## 10. Security & privacy framing (honest)

**What the relay CAN see:** the raw webhook body bytes and headers, in transit
through Cloud Run and at rest in Pub/Sub (GCP-encrypted in transit and at rest).
For most vendors that body carries business data (an order, a payment event, a
CRM change). This is a real disclosure and the Settings copy (§8) states it
plainly — "the relay forwards your webhook payloads; they are encrypted in
transit and at rest, but they do pass through our infrastructure."

**What the relay CANNOT see or do:**

- It never holds a **signing secret** — every HMAC/app secret stays in the local
  keychain and is revealed main-only per delivery (§6). The relay cannot forge a
  webhook the client would accept, and cannot verify one either.
- It never **verifies** — verification is local, over the raw bytes, with the
  keychain secret, via the exact same `handleWebhookDelivery` core as loopback.
  A body the relay tampered with fails local verification and is dropped (§5.2).
- It never **acts** — no flow action, no connector mutation, no keychain access.
  Every action still fires only from a gated action node on the user's machine
  (the connectors' §9 authority invariant is untouched).
- It never holds a **broad** GCP credential on the client's behalf — the client
  pulls with a **scoped, short-lived** drain token good only for this tenant's
  subscription (§6).

So the honest one-line framing: **raw payloads transit the relay (GCP-encrypted);
credentials, verification, and all actions stay on the machine.** That is a
weaker privacy claim than a fully-local loopback receiver (which discloses
nothing), and a much stronger one than handing a third party your API keys. The
feature is opt-in (`enabled` default false) and per-integration (you only
provision URLs for the connectors you choose), so a user who wants zero
disclosure simply doesn't enable it.

---

## 11. Open decisions (flagged)

- **O-1 — Pub/Sub pull: SDK vs. REST; streaming vs. periodic.** The
  `@google-cloud/pubsub` SDK gives streaming pull + lease management for free but
  is a heavy dependency (and this user's dev machine is RAM-constrained — the
  8 GB Electron+Claude budget). A thin REST `pull`/`acknowledge` loop is lighter
  and keeps the scoped-token handling explicit, but re-implements lease/backoff.
  Both sit behind `IngressSource` so the choice doesn't touch the tested core.
  Recommendation: **REST periodic pull** for the first live cut (smallest
  footprint), revisit streaming if latency matters.
- **O-2 — how a connector registers its `{verifier, parse, deliver}`.** The
  recommended seam (§4.3) is a `<connector>WebhookBinding(deliver, opts)` factory
  beside each `*-webhook-server.ts`'s existing verifier/parse exports, called at
  wiring time. Alternative: add an optional `webhookBinding()` method to
  `LiveConnector` so the registry can harvest bindings generically. The factory is
  less coupling and no contract change; the method is more discoverable.
  Recommendation: **factory now**, promote to a `LiveConnector` method only if a
  generic "enumerate all webhook-capable connectors" need appears.
- **O-3 — the relay control-API shape.** `HostedControlApi` pins the *client's*
  view (provision/list/mint), but the actual endpoints, auth header, error
  envelope, and token-refresh semantics are owned by the private relay repo and
  aren't frozen. `MockControlApi` lets the whole OSS client ship and be tested
  before that contract lands; `HttpControlApi` stays a loud stub until it does.
- **O-4 — where the account token lives.** Either extend `IntegrationId` with a
  `'hosted'` member so it rides `CredentialStore` unchanged (simplest, but
  `'hosted'` isn't an integration and would leak into descriptor/registry
  iteration), or give it a tiny dedicated store like `hubspot-token-store.ts`
  (cleaner separation, a little more code). Recommendation: **dedicated
  `hosted-token-store.ts`** so the integration enumerations stay clean.
- **O-5 — account-auth model.** Is the account token a static API key the user
  pastes (simplest MVP), or an OAuth-style flow with refresh? The MVP assumes a
  pasted long-lived token (§8) behind the seam; an OAuth device flow can replace
  the "paste a token" Settings step later without touching the drain path.
- **O-6 — one drain loop vs. per-integration.** A single subscription
  multiplexing all integrations (delivery carries `integration`) means one drain
  loop and one token — simplest, and what §4 assumes. Per-integration
  subscriptions would isolate a noisy connector but multiply tokens/loops.
  Deferred with the live Pub/Sub cut; the `Delivery.integration` tag keeps the
  single-loop design viable.

---

## 12. MVP slice & roadmap

**MVP slice (this branch, offline, tested):**

1. The `handleWebhookDelivery` refactor (§2) — behavior-preserving; existing
   webhook tests stay green.
2. `ingress-source.ts` (`IngressSource`, `Delivery`, `Ack`, `MockIngressSource`;
   `GcpPubSubIngressSource` deferred stub).
3. `webhook-bindings.ts` (`HostedWebhookBinding`, `WebhookBindingRegistry`) + the
   Shopify + HubSpot binding factories as the two worked examples.
4. `hosted-ingress.ts` (`HostedIngressClient`) with the §5 decision table.
5. `hosted-control-client.ts` (`HostedControlApi`, `MockControlApi`;
   `HttpControlApi` deferred stub) + `hosted-config.ts`.
6. Full offline test suite (§9).

**Roadmap (follow-ups):**

- **R1 — live Pub/Sub drain** (O-1): implement `GcpPubSubIngressSource`; wire the
  drain token refresh.
- **R2 — live control API** (O-3): implement `HttpControlApi` once the relay's API
  is frozen; wire the account-token store (O-4).
- **R3 — Settings surface** (§8): build the "Connect hosted ingress" panel + its
  IPC.
- **R4 — index.ts wiring**: construct the client, register the Shopify/HubSpot (+
  each connector's) binding as it's registered, gate `start(source)` on
  `HostedConfig.enabled`.
- **R5 — remaining connector bindings**: add the one-factory-one-register line for
  Stripe/GitHub/GitLab/Sentry/Woo/Linear (zero new security code each).
```
