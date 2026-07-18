# Connector shared infrastructure — design spec

- **Status:** draft (design only — no implementation code, no PR)
- **Date:** 2026-07-18
- **Branch:** `build/connector-infra`
- **Related:** `2026-07-16-integrations-hub-design.md`, `2026-07-16-linear-integration-design.md` (§4.4), `2026-07-17-shopify-connector-design.md`, `2026-07-17-woocommerce-connector-design.md`

---

## 1. Goal & scope

localflow now ships five connectors (Linear, email, cloud, Shopify,
WooCommerce) and roughly eight more are queued (Stripe, GitHub, HubSpot,
Sentry, GitLab, Slack, …). Three security-critical pieces have been
**copy-pasted per connector** and are drifting:

1. **The webhook receiver.** `linear-webhook-server.ts`,
   `shopify-webhook-server.ts`, and `wc-webhook-server.ts` are ~200 lines each
   and are byte-for-byte identical except for a signature header name, an
   encoding, and (Shopify) a dedup hook / (Woo) a ping short-circuit. Every new
   webhook connector currently means a new hand-written HTTP server that re-does
   HMAC, the `responded` guard, the size cap, and the 200-fast tick — i.e. new
   security-critical code each time.
2. **Money.** Shopify normalizes to a major-unit `number`
   (`shopify-normalize.ts`), Woo coerces its string `total` to a `number`
   (`wc-normalize.ts`), and there is no shared convention. Stripe reports
   **minor units** (integer cents / zero-decimal yen), so a cross-connector
   condition like `stripe.refund.amount gt shopify.order.total` would compare
   `4200` against `42.5` and silently misfire.
3. **The SSRF guard.** `wc-ssrf.ts` is a real, well-tested security control on a
   user-supplied self-host URL — including the subtle IPv4-mapped-IPv6 fix and
   the post-DNS `blockedIpRange` hook. Every future self-host connector (GitLab,
   GHES, self-host Sentry / PostHog / Grafana) needs exactly this and would
   otherwise re-implement it.

**This spec extracts those three into shared modules so a new connector is
CONFIG, not new security-critical code.** It is a **behavior-preserving
refactor spec**: existing connectors get rewired to the shared modules and
their existing tests must stay green (byte-equivalent behavior). No new
connector is built here.

**Out of scope:** live cloud ingress (tunnel/relay — still deferred per Linear
spec §4.4), the connector registry/`invokeAction` seam (owned by the
Integrations Hub), any actual Stripe/GitHub/… connector, and real outbound HTTP
transport (the SSRF guard stays pure; DNS resolution belongs to whichever
transport eventually calls `blockedIpRange`).

### 1.1 What is identical today (extract verbatim)

Confirmed by reading the three receivers side by side
(`linear-webhook-server.ts:148-233`, `shopify-webhook-server.ts:89-198`,
`wc-webhook-server.ts:102-198`):

- `createServer` from `node:http`; `applyLoopbackTimeouts(server)`
  (`server-timeouts.ts`); default bind `127.0.0.1`; default port `0` (ephemeral,
  read back from `server.address()`); Promise resolves after `listen`.
- `MAX_BODY_BYTES = 1_048_576` on every one.
- Wrong method/path → `404`. Size cap exceeded → `413` + `req.destroy()`.
- The `responded` latch plus `req.on('error', () => { responded = true })`
  mid-body guard (a mid-body reset emits `'error'`; with no listener it crashes
  the main process — see the identical comments at
  `linear-webhook-server.ts:164`, `shopify:108`, `wc:118`).
- Timing-safe HMAC via the re-hash trick
  `timingSafeEqual(sha256(expected), sha256(providedBuf))` so a length mismatch
  never throws (`verifyLinearSignature` L64-73, `verifyShopifySignature`
  L69-79, `verifyWcSignature` L71-77).
- **Empty-secret rejection** (`secret.length === 0` → `false`) — an empty-key
  HMAC is forgeable by anyone who knows the body.
- **Verify over the RAW body BEFORE parse** — a body-parser that drains the
  stream first would break HMAC (Shopify comment L129, §2.2).
- **200-fast**: commit the response, then `setImmediate(() => deliver(event))`
  wrapped in try/catch that logs **route + reason only**.
- `onEvent(handler)` / `close()` / `port` server handle shape.
- The `log` callback **never** receives the secret or the body (asserted by a
  "never logs the secret" test in all three:
  `shopify-webhook-server.test.ts:112`, `wc:147`, and the Linear equivalent).

### 1.2 What differs per vendor (becomes config)

| Vendor | Signature header | Algo | Encoding | Timestamp | Pre-verify short-circuit | Post-verify dedup |
|--------|------------------|------|----------|-----------|--------------------------|-------------------|
| Linear | `linear-signature` | sha256 | hex | no | — | — |
| Shopify | `x-shopify-hmac-sha256` | sha256 | base64 | no | — | `x-shopify-webhook-id` → 200+drop |
| Woo | `x-wc-webhook-signature` | sha256 | base64 | no | **ping**: no `x-wc-webhook-topic` → 200, no run (BEFORE verify) | — |

Two ordering subtleties the refactor **must** preserve for byte-equivalence:

- **Woo pings are 200'd BEFORE signature verification** (`wc-webhook-server.ts:141-148`;
  test "200s a ping … WITHOUT spawning a run" at `wc-webhook-server.test.ts:102`
  sends no valid signature and still expects 200). → the shared receiver needs a
  **pre-verify acknowledge** hook.
- **Shopify dedups AFTER verify, BEFORE parse** (`shopify-webhook-server.ts:130-144`).
  → a **post-verify dedup** hook, distinct from the pre-verify one.

The future schemes the connector research turned up, all expressible in the
same config: HMAC-SHA256 timestamp+body with a replay window (Stripe
`t=..,v1=..`; GitHub `X-Hub-Signature-256`), HMAC-SHA1 (Intercom), and a plain
shared-secret **bearer token** (GitLab `X-Gitlab-Token`, a constant-time string
compare, no HMAC).

---

## 2. The three pinned contracts (verbatim types)

### 2.1 `src/main/webhooks/webhook-receiver.ts` — parameterized receiver

```ts
import type { IncomingHttpHeaders } from 'node:http'

/**
 * How a connector's webhooks are authenticated. One of two schemes:
 *  - 'hmac'  — timing-safe HMAC over the raw body (optionally timestamp+body
 *              with a replay window). Covers Shopify, Woo, Linear, Stripe,
 *              GitHub, Intercom.
 *  - 'token' — a plain shared secret compared timing-safely against a header
 *              value (no HMAC, no body). Covers GitLab `X-Gitlab-Token`.
 */
export type WebhookVerifier =
  | {
      scheme: 'hmac'
      /** Digest algorithm. Default 'sha256'. Intercom uses 'sha1'. */
      algo?: 'sha256' | 'sha1'
      /** Header carrying the signature (lower-case; Node lower-cases headers). */
      header: string
      /** How the provided signature is encoded. Default 'hex'. */
      encoding?: 'hex' | 'base64'
      /**
       * When true, the HMAC is computed over `${timestamp}.${rawBody}` (Stripe)
       * — NOT the body alone — and the delivery is rejected when the timestamp
       * is outside `toleranceSec` (replay defense). Default false.
       */
      signsTimestamp?: boolean
      /** Header carrying the signing timestamp (Stripe `Stripe-Signature` `t=`). */
      timestampHeader?: string
      /** Replay window in seconds when `signsTimestamp`. Default 300. */
      toleranceSec?: number
      /**
       * Extract the signature (and, if `signsTimestamp`, the timestamp) from
       * the raw header value. Defaults to "the whole header value is the
       * signature". Stripe/GitHub override it to parse `t=..,v1=..` /
       * `sha256=..`. Pure; returns null when the header is unparseable.
       */
      parseHeader?: (raw: string) => { signature: string; timestamp?: string } | null
    }
  | {
      scheme: 'token'
      /** Header carrying the shared secret, e.g. 'x-gitlab-token'. */
      header: string
    }

/**
 * A per-vendor short-circuit consulted at a fixed pipeline stage. Returns a
 * status code to answer-and-stop (no verify/parse/deliver), or null to
 * continue. Both hooks see only headers — never the secret.
 *
 *  - `preVerify`  — Woo's ping: no topic header ⇒ return 200, spawn nothing.
 *                   Runs BEFORE signature verification (a ping isn't signed).
 *  - `dedup`      — Shopify's `X-Shopify-Webhook-Id`: a duplicate ⇒ return 200
 *                   and drop. Runs AFTER verify, BEFORE parse. The hook owns its
 *                   own seen-set and records the id when it decides to continue.
 */
export type ShortCircuit = (headers: IncomingHttpHeaders) => number | null

/**
 * Turn a verified raw body + headers into the connector's event, or null when
 * the shape is unsupported/unusable (→ 400, no run). This is the ONLY
 * vendor-specific parsing; it stays in the connector (e.g. `parseLinearEvent`,
 * `parseWcOrderBody`, Shopify's inline JSON-object guard + `webhookToPayload`).
 */
export type WebhookParser<E> = (rawBody: Buffer, headers: IncomingHttpHeaders) => E | null

export interface WebhookReceiverConfig<E> {
  /** Route the vendor POSTs to, e.g. '/shopify/webhook'. */
  path: string
  /** Verification scheme (§2.1). */
  verifier: WebhookVerifier
  /** Vendor body → event. */
  parse: WebhookParser<E>
  /** The keychain-sourced secret (HMAC key or shared token). NEVER logged. */
  secret: string
  /** Raw-body ceiling. Default 1_048_576 (every current connector's value). */
  maxBodyBytes?: number
  /** Bind host. Default '127.0.0.1' (loopback; cloud ingress via tunnel/relay). */
  host?: string
  /** Port. Default 0 (ephemeral; read back after listen). */
  port?: number
  /** Optional pre-verify acknowledge (Woo ping). */
  preVerify?: ShortCircuit
  /** Optional post-verify dedup (Shopify webhook-id). */
  dedup?: ShortCircuit
  /** Route + reason logger. NEVER receives the secret or the body. */
  log?: (message: string) => void
}

export interface WebhookReceiver<E> {
  readonly port: number
  onEvent(handler: (event: E) => void): void
  close(): void
}

/**
 * Start ONE loopback webhook receiver from config. The fixed pipeline is:
 *
 *   404 (method/path) → collect body (413 over cap, `responded`/error guard)
 *     → preVerify? → verify (raw body, BEFORE parse; 401 on fail)
 *     → dedup? → parse (400 on null) → 200-fast → setImmediate(deliver)
 *
 * Every security invariant of the three hand-written servers is preserved:
 * timing-safe compare, empty-secret rejection, verify-before-parse, size cap,
 * 200-fast, loopback bind, secret/body never logged.
 */
export function startWebhookReceiver<E>(
  config: WebhookReceiverConfig<E>
): Promise<WebhookReceiver<E>>

/** Timing-safe HMAC/token verification (exported for direct unit testing). */
export function verifyWebhookSignature(
  rawBody: Buffer,
  headers: IncomingHttpHeaders,
  verifier: WebhookVerifier,
  secret: string,
  now?: () => number
): boolean
```

**Pipeline order (pinned — this is what makes it byte-equivalent):**

1. `req.method !== 'POST' || req.url !== path` → `404`.
2. Collect body with the `responded` latch + `error` guard; over
   `maxBodyBytes` → `413` + `req.destroy()`.
3. On `end`: `preVerify?.(headers)` → if it returns a code, write it and stop
   (Woo ping).
4. `verifyWebhookSignature(rawBody, headers, verifier, secret)` → `401` on
   failure. (Raw body; before any parse.)
5. `dedup?.(headers)` → if it returns a code, write it and stop (Shopify
   duplicate). The hook records the id internally when it returns null.
6. `parse(rawBody, headers)` → `null` ⇒ `400`.
7. `res.writeHead(200); res.end()`, then `setImmediate(() => deliver(event))`
   inside try/catch logging route + reason.

`verifyWebhookSignature` for `scheme: 'hmac'`: reject non-string / empty
provided sig and empty secret; when `signsTimestamp`, reject a missing/NaN
timestamp or one outside `toleranceSec` of `now()`, then HMAC over
`${timestamp}.${rawBody}`, else HMAC over `rawBody`; compare with the re-hash
`timingSafeEqual(sha256(expected), sha256(provided))` trick. For
`scheme: 'token'`: reject empty secret / missing header, then
`timingSafeEqual(sha256(secretBuf), sha256(providedBuf))`.

### 2.2 `src/shared/money.ts` — money convention

```ts
/**
 * localflow's cross-connector money vocabulary. Amounts are always in MAJOR
 * units (dollars, euros, yen) as a `number`, so conditions compare numerically
 * and consistently regardless of which connector produced them.
 *
 * Shopify/Woo already emit major-unit numbers (this formalizes that). Stripe,
 * GitHub Sponsors, and most billing APIs emit MINOR units (integer cents, or
 * whole yen for zero-decimal currencies) — `minorToMajor` converts those so
 * `stripe.refund.amount` and `shopify.order.total` live on the same scale.
 */
export interface Money {
  /** Amount in MAJOR units, e.g. 42.5 for $42.50. */
  amount: number
  /** ISO-4217 code, upper-case, e.g. 'USD', 'JPY', 'BHD'. */
  currency: string
}

/**
 * Number of decimal places for a currency (ISO-4217 minor-unit exponent).
 * Unlisted currencies default to 2. Covers the exceptions that matter:
 *  - 0 decimals: JPY, KRW, VND, CLP, ISK, HUF (billing sense), XOF, XAF, …
 *  - 3 decimals: BHD, KWD, OMR, JOD, TND, IQD, LYD, …
 */
export function currencyDecimals(currency: string): number

/**
 * Convert a MINOR-unit integer (Stripe cents / whole yen) to MAJOR units using
 * the currency's decimal count. `minorToMajor(4200, 'USD') === 42`,
 * `minorToMajor(4200, 'JPY') === 4200`, `minorToMajor(4200, 'BHD') === 4.2`.
 * Non-finite input → 0 (mirrors the never-throw normalization discipline).
 */
export function minorToMajor(minor: number, currency: string): number

/** Build a normalized `Money` from a minor-unit integer (Stripe path). */
export function moneyFromMinor(minor: number, currency: string): Money
```

**Currency-mismatch caveat (pinned as documentation, enforced by the
conditions track, not by this module):** comparing two `Money.amount`s is only
meaningful when their `currency` matches. `minorToMajor` fixes the *scale*
mismatch (cents vs. dollars); it does **not** convert between currencies (no FX).
A condition comparing `stripe.refund.amount` to `shopify.order.total` across
different `currency` values is comparing unlike quantities — the condition
authoring surface should compare `.currency` first (or warn). This module makes
same-currency comparisons correct; it deliberately does not invent an FX rate.

### 2.3 `src/main/net/ssrf-guard.ts` — shared SSRF guard

Promotes `wc-ssrf.ts` **verbatim in behavior** (https-only; no embedded
credentials; block unspecified / loopback / private / link-local, including the
IPv4-mapped-IPv6 hex-and-dotted handling WHATWG `new URL()` normalizes to; the
post-DNS `blockedIpRange` hook; pure, never resolves DNS itself).

```ts
export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string }

/**
 * Validate a user-supplied self-host base URL BEFORE any outbound request:
 * https-only, no embedded credentials, rejects a `localhost`/`*.localhost` name
 * and any IP-literal host in a private/loopback/link-local range. A DNS
 * hostname passes here and MUST be re-checked against its resolved IP by
 * `blockedIpRange` at dial time (DNS-rebinding defense).
 *
 * `label` names the field for the error text ('Store URL', 'GitLab URL',
 * 'Sentry URL'), replacing wc-ssrf's hard-coded "Store URL"/"Settings" strings
 * so every self-host connector gets a legible, connector-appropriate message.
 */
export function checkBaseUrl(raw: string, label?: string): UrlCheck

/**
 * The range label if a resolved IP (v4, or v6 literal without brackets) is
 * private/loopback/link-local/unspecified, else null. The hook a real transport
 * calls with the IP it ACTUALLY dialed. Byte-equivalent to wc-ssrf's
 * `blockedIpRange`, including the IPv4-mapped-IPv6 reconstruction.
 */
export function blockedIpRange(ip: string): string | null
```

The internal helpers (`parseIpv4`, `blockedIpv4`, `blockedIpv6`) move verbatim.
The only surface change is parameterizing the error `label` (`checkStoreUrl` →
`checkBaseUrl`) so the message isn't Woo-specific — the range-detection logic,
including the mapped-IPv6 fix, is unchanged.

---

## 3. Refactor plan (behavior-preserving)

### 3.1 Deliverable 1 — webhook receiver

**New:** `src/main/webhooks/webhook-receiver.ts` (§2.1).

**Rewire the three existing receivers to supply a config.** Each keeps its
file and public surface (`start*WebhookServer`, the exported
`verify*Signature`, the vendor `parse*`) but its body becomes a thin call to
`startWebhookReceiver`:

- `src/main/linear/linear-webhook-server.ts` — verifier
  `{ scheme:'hmac', header:'linear-signature', encoding:'hex' }`, `parse` wraps
  `parseLinearEvent(rawBody.toString('utf8'))`. Keep exported
  `LINEAR_SIGNATURE_HEADER`, `LINEAR_MAX_BODY_BYTES`, `parseLinearEvent`,
  `verifyLinearSignature`. No preVerify, no dedup.
- `src/main/shopify/shopify-webhook-server.ts` — verifier
  `{ scheme:'hmac', header:'x-shopify-hmac-sha256', encoding:'base64' }`;
  `dedup` closes over a `Set` and consults `x-shopify-webhook-id`; `parse`
  does the JSON-object guard and builds `ShopifyWebhookDelivery`
  (`webhookId` / `x-shopify-topic` / payload). Keep the exported header
  constants and `verifyShopifySignature`.
- `src/main/woocommerce/wc-webhook-server.ts` — verifier
  `{ scheme:'hmac', header:'x-wc-webhook-signature', encoding:'base64' }`;
  `preVerify` returns 200 when `x-wc-webhook-topic` is absent (ping); `parse`
  wraps `parseWcOrderBody` and attaches `x-wc-webhook-delivery-id`. Keep the
  exported header constants, `parseWcOrderBody`, `verifyWcSignature`.

**Open decision O-1** flags whether these three files survive as thin wrappers
or are deleted with call-sites moved onto `startWebhookReceiver` directly.

### 3.2 Deliverable 2 — money

**New:** `src/shared/money.ts` (§2.2).

- **Shopify:** `shopify-normalize.ts:30` `moneyToNumber` already yields major
  units; annotate `ShopifyOrderContext.total` / `totalSpent`
  (`src/shared/shopify.ts:60`) as conforming to `Money.amount` semantics. No
  numeric change — this is a documentation/typing formalization so the existing
  `shopify-normalize.test.ts` stays green.
- **Woo:** `wc-normalize.ts` `num(o.total)` already yields major units — same
  formalization, no numeric change.
- **No connector switches to `minorToMajor` in this refactor** (none currently
  ingest minor units). `minorToMajor` / `moneyFromMinor` exist for the first
  minor-unit connector (Stripe) to consume — see §4.

### 3.3 Deliverable 3 — SSRF guard

**New:** `src/main/net/ssrf-guard.ts` (§2.3) — `wc-ssrf.ts` moved with the
`checkStoreUrl` → `checkBaseUrl(raw, label)` rename.

- **Woo:** `src/main/woocommerce/wc-api.ts:1,135` imports `checkStoreUrl` from
  `./wc-ssrf`; rewire to `checkBaseUrl(this.storeUrl, 'Store URL')` from
  `../net/ssrf-guard`. The reason strings stay identical for the `'Store URL'`
  label so no downstream error assertion changes.
- **`wc-ssrf.ts`:** either re-export from the shared module (keeps
  `wc-ssrf.test.ts` importing `./wc-ssrf` unchanged) or the test moves to
  import the shared module. **Open decision O-2.** Either way the Woo SSRF tests
  — including "flags IPv4-mapped IPv6 in the hex form WHATWG normalizes to"
  (`wc-ssrf.test.ts:77`) and "does NOT over-block a genuinely public
  IPv4-mapped address" (`:92`) — must pass unchanged.

**Files touched, at a glance:** new `webhook-receiver.ts`, `money.ts`,
`ssrf-guard.ts`; edited `linear-webhook-server.ts`, `shopify-webhook-server.ts`,
`wc-webhook-server.ts`, `wc-api.ts`, `wc-ssrf.ts`, `shopify.ts` (doc/typing),
`shopify-normalize.ts` (doc). No test file needs a behavioral edit; new test
files are additive (§5).

---

## 4. How a FUTURE connector consumes each (worked: Stripe)

Stripe is the acid test — it exercises the timestamp+replay verifier AND
minor-unit money.

**Webhook.** Stripe signs `${t}.${rawBody}` and sends
`Stripe-Signature: t=1699999999,v1=<hex>` with a recommended 5-minute
tolerance:

```ts
startWebhookReceiver<StripeEvent>({
  path: '/stripe/webhook',
  secret: revealForConnector('stripe', 'webhookSecret'),   // keychain, main-only
  verifier: {
    scheme: 'hmac',
    algo: 'sha256',
    header: 'stripe-signature',
    encoding: 'hex',
    signsTimestamp: true,
    toleranceSec: 300,
    parseHeader: (raw) => {                  // 't=..,v1=..' → { timestamp, signature }
      const parts = Object.fromEntries(raw.split(',').map((p) => p.split('=')))
      return parts.t && parts.v1 ? { timestamp: parts.t, signature: parts.v1 } : null
    }
  },
  parse: (rawBody) => parseStripeEvent(rawBody.toString('utf8'))  // vendor-owned
})
```

No new HTTP server, no new HMAC code, no new size-cap/`responded`/200-fast
logic — the replay window, timing-safe compare, and empty-secret rejection all
come from the shared receiver. GitHub is the same shape with
`header:'x-hub-signature-256'`, `parseHeader` stripping the `sha256=` prefix,
and `signsTimestamp:false`. GitLab drops HMAC entirely:
`verifier: { scheme:'token', header:'x-gitlab-token' }`. Intercom sets
`algo:'sha1'`.

**Money.** A Stripe `charge.refunded` reports `amount_refunded` in minor units:

```ts
import { moneyFromMinor } from '../../shared/money'
const refund = moneyFromMinor(evt.amount_refunded, evt.currency)  // 4200,'usd' → { amount:42, currency:'USD' }
// now stripe.refund.amount (42) and shopify.order.total (42.5) compare on the same scale
```

**Self-host (GitLab / GHES / self-host Sentry).** The `baseUrl` config field
routes through the shared guard before the first request:

```ts
import { checkBaseUrl, blockedIpRange } from '../net/ssrf-guard'
const check = checkBaseUrl(cfg.baseUrl, 'GitLab URL')
if (!check.ok) throw new Error(check.reason)
// …and the transport passes the resolved IP through blockedIpRange at dial time.
```

New connector = a verifier config + a vendor `parse` + (for self-host) a
`checkBaseUrl` call. Zero new security-critical code.

---

## 5. Error handling

Per the house error-message style (human language, actionable, carries the real
exception; no bare "not found / no connection"):

- **Receiver HTTP responses are unchanged**: `404` wrong route, `413` oversize,
  `401` verification failure, `400` unparseable/unsupported, `200` success /
  ping / duplicate. The `log(route + reason)` lines are preserved verbatim in
  wording so the "never logs the secret/body" tests keep passing.
- **New replay rejection** (Stripe path): logged as
  `"<route>: rejected — signature timestamp outside the <N>s tolerance"` — a
  reason, never the timestamp value or secret.
- **`checkBaseUrl`** keeps wc-ssrf's legible reasons (`"… must be https:// —
  plain HTTP would send the API keys in the clear"`, `"… is a private/loopback
  address (<range>) — refusing to call it"`), now parameterized by `label` so a
  GitLab misconfig doesn't say "Store URL … fix it in Settings".
- **`minorToMajor`** never throws — non-finite input coerces to 0, matching the
  never-throw normalization discipline (`shopify-normalize.ts:32`,
  `wc-normalize.ts`), so a malformed amount can't crash a run.
- Secrets: the receiver's `secret` and every connector token continue to flow
  **only** from `CredentialStore.revealForConnector` (main-process-only) and are
  never logged, echoed, or placed in argv (global secret-handling rules).

## 6. Testing

**Existing tests stay green (byte-equivalence gate).** No behavioral edits to:
`linear-webhook-server.test.ts`, `shopify-webhook-server.test.ts`,
`wc-webhook-server.test.ts` (incl. "200s a ping … WITHOUT spawning a run" and
the "never logs the secret" cases), `wc-ssrf.test.ts` (incl. the mapped-IPv6
fix and public-mapped-address cases), `shopify-normalize.test.ts`,
`wc-normalize.test.ts`, `shopify-flow-integration.test.ts`. Run `npm test`
(vitest) + `npm run typecheck` as the gate.

**New — receiver verifier-scheme matrix** (`webhook-receiver.test.ts`): a table
driving `verifyWebhookSignature` / `startWebhookReceiver` across every scheme
so future connectors are covered by construction:

- HMAC-SHA256 hex (Linear), base64 (Shopify/Woo) — accept correct, reject
  forged / non-string / empty-secret / empty-signature.
- HMAC-SHA256 **timestamp+body** (Stripe): accept in-window; reject when the
  timestamp is stale (> `toleranceSec`), missing, or NaN; reject a body signed
  without the `t.` prefix — proving replay defense.
- HMAC-SHA1 (Intercom) accept/reject.
- Bearer **token** (GitLab): accept exact secret, reject wrong/empty, confirm
  timing-safe compare (no length-throw).
- `parseHeader` for `t=..,v1=..` and `sha256=..`; unparseable header → reject.
- Pipeline: `preVerify` 200s a ping before verify; `dedup` 200s+drops a repeat
  after verify; oversize → 413 before verify/parse; wrong path → 404; 200-fast
  then single deliver; handler throw is caught + logged; secret/body never
  logged (a spy asserts it).

**New — money** (`money.test.ts`): `currencyDecimals` for 2- / 0- (JPY, KRW) /
3-decimal (BHD, KWD) currencies + unlisted default 2; `minorToMajor(4200,·)`
→ 42 / 4200 / 4.2; `moneyFromMinor` upper-cases currency; non-finite → 0;
a same-scale cross-connector comparison (`moneyFromMinor(4200,'USD').amount`
vs a Shopify `42.5`) resolves the way a condition expects.

**New — ssrf-guard** (`ssrf-guard.test.ts`): thin — the exhaustive coverage
lives in `wc-ssrf.test.ts`; this adds only the `label` parameterization (a
non-'Store URL' label appears in the reason).

## 7. Open decisions (flagged)

- **O-1 — thin wrappers vs. delete.** Keep `linear/shopify/wc-webhook-server.ts`
  as thin `startWebhookReceiver` wrappers (smallest diff, existing imports and
  exported constants/`parse*`/`verify*` unchanged, tests untouched) **or**
  delete them and move connector call-sites + tests onto `startWebhookReceiver`
  directly (less code, bigger diff). Recommendation: **wrappers now** for a
  clean byte-equivalent refactor; revisit once ≥2 more connectors exist.
- **O-2 — where the dedup seen-set lives / its shape.** Today Shopify's `Set`
  lives in the server closure and is unbounded (a long-lived process grows it).
  Options: keep the closure `Set` (byte-equivalent), or make `dedup` a
  first-class config with a bounded LRU / TTL. Also: should dedup be generalized
  (Stripe's `event.id`, GitHub's `X-GitHub-Delivery` are all "seen-id → 200")
  into a standard `dedupHeader?: string` + shared bounded store rather than a
  hand-written `ShortCircuit` per vendor? Recommendation: ship the
  `ShortCircuit` seam now; generalize to `dedupHeader` when the second deduping
  connector lands.
- **O-3 — receiver lifecycle ownership.** Who calls `startWebhookReceiver` /
  `close()`, and when? Today each connector owns its server ad hoc. Candidate:
  the Integrations Hub owns a receiver-per-enabled-connector lifecycle
  (start on enable, close on disable/quit) so ports and cloud-ingress
  registration are managed in one place. Out of scope to build here; flagged so
  the shared receiver's `close()`/`port` surface is designed for an external
  owner.
- **O-4 — one shared port vs. one per connector.** Each connector currently
  binds its own ephemeral loopback port. A single receiver multiplexing by
  `path` would mean one tunnel/relay endpoint for all connectors (simpler cloud
  ingress) but couples connector lifecycles. Deferred with cloud ingress (§1
  out-of-scope); noted because it interacts with O-3.
- **O-5 — `Money` object vs. loose fields.** Connectors currently expose
  parallel `total: number` + `currency: string` fields, not a `Money` object.
  Do normalized contexts adopt `Money` as a nested object (cleaner, but changes
  the pinned `ShopifyOrderContext` shape and its tests) or keep parallel fields
  and treat `money.ts` purely as the conversion + convention authority?
  Recommendation: **parallel fields + convention** now (zero churn to green
  tests); reconsider a `Money` object only if the conditions track wants it.
