import { createServer } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { applyLoopbackTimeouts } from '../server-timeouts'

/**
 * The parameterized webhook receiver: ONE loopback HTTP server, driven by
 * config, that every webhook connector (Linear, Shopify, Woo, and future
 * Stripe/GitHub/GitLab/Intercom/…) shares instead of hand-rolling its own
 * security-critical HTTP + HMAC code.
 *
 * Every invariant of the three hand-written receivers is preserved:
 *  - `createServer` + `applyLoopbackTimeouts`; loopback bind; ephemeral port.
 *  - `MAX_BODY_BYTES` size cap → 413 + `req.destroy()`.
 *  - the `responded` latch + mid-body `'error'` guard (a reset emits `'error'`;
 *    with no listener that crashes the main process).
 *  - timing-safe HMAC via the re-hash trick, empty-secret rejection, and
 *    verification over the RAW body BEFORE any parse.
 *  - 200-fast: commit the response, then `setImmediate(() => deliver(event))`
 *    inside try/catch that logs route + reason only.
 *  - the `log` callback NEVER receives the secret or the body.
 */

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
      /** Header carrying the signing timestamp when it is NOT embedded in the
       *  signature header (Slack `X-Slack-Request-Timestamp`, HubSpot
       *  `X-HubSpot-Request-Timestamp`). Stripe embeds it in `t=` instead. */
      timestampHeader?: string
      /** Unit of the timestamp value. Stripe/Slack send seconds; HubSpot sends
       *  milliseconds. Default 'seconds'. Only affects the replay-window math —
       *  the RAW timestamp string is what gets signed. */
      timestampUnit?: 'seconds' | 'milliseconds'
      /** Replay window in seconds when `signsTimestamp`. Default 300. */
      toleranceSec?: number
      /**
       * Extract the signature (and, if `signsTimestamp`, the timestamp) from
       * the raw header value. Defaults to "the whole header value is the
       * signature". Vendors override it:
       *  - Stripe: parse `t=..,v1=..` → `{ timestamp, signature }`.
       *  - GitHub: strip the `sha256=` prefix → `{ signature }`.
       *  - Slack:  strip the `v0=` prefix → `{ signature }` (timestamp comes
       *            from the separate `timestampHeader`).
       * Pure; returns null when the header is unparseable.
       */
      parseHeader?: (raw: string) => { signature: string; timestamp?: string } | null
      /**
       * Compose the signed base string from the full ingredient set. The
       * composition DIFFERS per vendor:
       *  - Shopify/GitHub/Sentry/Linear (default, no composer): `rawBody` alone.
       *  - Stripe: `${timestamp}.${rawBody}`.
       *  - Slack:  `v0:${timestamp}:${rawBody}`.
       *  - HubSpot v3: `${method}${requestUri}${rawBody}${timestamp}` — where
       *    `requestUri` is the PUBLIC delivered URL (`WebhookReceiverConfig.publicUrl`),
       *    NOT the loopback `req.url`, because HubSpot signs the URL it delivered to.
       * When omitted, the body-only path signs the raw body bytes directly
       * (byte-exact) unless `signsTimestamp`, which then defaults to Stripe's
       * `${timestamp}.${rawBody}`.
       */
      baseString?: (parts: {
        method: string
        requestUri: string
        timestamp: string
        rawBody: string
      }) => string
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
 * `parseWcOrderBody`, Shopify's inline JSON-object guard + delivery build).
 */
export type WebhookParser<E> = (rawBody: Buffer, headers: IncomingHttpHeaders) => E | null

export interface WebhookReceiverConfig<E> {
  /** Route the vendor POSTs to, e.g. '/shopify/webhook'. */
  path: string
  /** Verification scheme. */
  verifier: WebhookVerifier
  /** Vendor body → event. */
  parse: WebhookParser<E>
  /** The keychain-sourced secret (HMAC key or shared token). NEVER logged. */
  secret: string
  /** Raw-body ceiling. Default 1_048_576 (every current connector's value). */
  maxBodyBytes?: number
  /** Bind host. Default '127.0.0.1' (loopback; cloud ingress via tunnel/relay).
   *  Parameterizable so a future opt-in LAN bind can be added without touching
   *  the pipeline — loopback stays the default. */
  host?: string
  /** The PUBLIC URL the vendor delivers to (tunnel/relay). Fed to a `baseString`
   *  composer as `requestUri` — required for HubSpot v3, which signs the
   *  delivered URL, not the loopback path. Ignored by every other scheme. */
  publicUrl?: string
  /** Port. Default 0 (ephemeral; read back after listen). */
  port?: number
  /** Optional pre-verify acknowledge (Woo ping). */
  preVerify?: ShortCircuit
  /** Optional post-verify dedup (Shopify webhook-id). */
  dedup?: ShortCircuit
  /** Clock for the verifier's replay window. Default `Date.now`. Injectable so a
   *  test can pin freshness; the HTTP path leaves it default (byte-for-byte the
   *  `Date.now` the receiver used inline before). */
  now?: () => number
  /** Route + reason logger. NEVER receives the secret or the body. */
  log?: (message: string) => void
}

/**
 * The outcome of running the verify→dedup→parse policy on one delivery. `status`
 * is the SAME numeric code the HTTP server would have written, so the HTTP path
 * maps it straight to `res.writeHead(status)` and the hosted path maps it to
 * ack/nack. `event` is present ONLY on a 200 that produced an event to deliver (a
 * 200 short-circuit — Woo ping / Shopify dedup-drop — carries none).
 */
export interface DeliveryOutcome<E> {
  status: 200 | 400 | 401
  /** The parsed event to deliver, or undefined for a short-circuit 200. */
  event?: E
  /** A stable machine reason for logging/metrics — never the secret or body. */
  reason: 'delivered' | 'pre-verify-short-circuit' | 'verify-failed' | 'duplicate' | 'unparseable'
}

/**
 * Inputs the policy needs, transport-agnostic. `rawBody` is ALREADY collected
 * (the caller owns size limiting: the HTTP server via its 413 cap, the hosted
 * source via the relay's body ceiling). `publicUrl` is the PUBLIC delivered URL a
 * `baseString` composer signs (HubSpot); it defaults to `config.publicUrl`.
 */
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
 * `req.on('end')` handler (steps 3–6): preVerify → verify-over-raw-body → dedup →
 * parse. It does NOT deliver — the caller decides how to deliver on a
 * `status: 200` with an `event` (the HTTP path `setImmediate`s it after writing
 * 200; the hosted path awaits its handler before acking).
 *
 * Every invariant is preserved because the SAME lines move here unchanged:
 * empty-secret rejection, timing-safe compare, verify-before-parse, the
 * preVerify/dedup ordering, and the log callback never seeing the secret/body.
 */
export function handleWebhookDelivery<E>(
  config: WebhookReceiverConfig<E>,
  input: DeliveryInput
): DeliveryOutcome<E> {
  const log = config.log ?? ((m: string) => console.warn(m))
  const path = config.path
  const rawBody = input.rawBody
  const headers = input.headers

  // Pre-verify short-circuit (Woo ping): answer BEFORE any verification.
  if (config.preVerify) {
    const code = config.preVerify(headers)
    if (code !== null) {
      log(`webhook ${path}: pre-verify short-circuit (${code}) — no run seeded`)
      return { status: code as DeliveryOutcome<E>['status'], reason: 'pre-verify-short-circuit' }
    }
  }

  // Verify over the RAW body, BEFORE parsing — never trust an unauthenticated
  // body's shape. `requestUri` is the PUBLIC delivered URL (HubSpot signs it),
  // falling back to `config.publicUrl`.
  if (
    !verifyWebhookSignature(
      rawBody,
      headers,
      config.verifier,
      config.secret,
      config.now ?? Date.now,
      {
        method: input.method ?? 'POST',
        requestUri: input.publicUrl ?? config.publicUrl ?? ''
      }
    )
  ) {
    log(`webhook ${path}: rejected — signature verification failed`)
    return { status: 401, reason: 'verify-failed' }
  }

  // Post-verify dedup (Shopify webhook-id): 200 + drop a duplicate. The hook
  // records the id when it returns null (continue).
  if (config.dedup) {
    const code = config.dedup(headers)
    if (code !== null) {
      log(`webhook ${path}: duplicate delivery — dropped`)
      return { status: code as DeliveryOutcome<E>['status'], reason: 'duplicate' }
    }
  }

  const event = config.parse(rawBody, headers)
  if (event === null) {
    log(`webhook ${path}: rejected — unsupported or malformed payload`)
    return { status: 400, reason: 'unparseable' }
  }

  return { status: 200, event, reason: 'delivered' }
}

export interface WebhookReceiver<E> {
  readonly port: number
  onEvent(handler: (event: E) => void): void
  close(): void
}

const DEFAULT_MAX_BODY_BYTES = 1_048_576
const DEFAULT_TOLERANCE_SEC = 300

function digest(algo: 'sha256' | 'sha1', input: Buffer): Buffer {
  return createHash(algo).update(input).digest()
}

/** Re-hash both sides with sha256 so `timingSafeEqual` never throws on a length
 *  mismatch (the operator-grant / hook-server trick). */
function timingSafeMatch(a: Buffer, b: Buffer): boolean {
  return timingSafeEqual(digest('sha256', a), digest('sha256', b))
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const v = headers[name]
  if (typeof v === 'string') return v
  return undefined
}

/**
 * Timing-safe HMAC/token verification (exported for direct unit testing).
 *
 * `scheme: 'hmac'`: reject a non-string / empty provided signature and an empty
 * secret; when `signsTimestamp`, reject a missing/NaN timestamp or one outside
 * `toleranceSec` of `now()`, then HMAC over `${timestamp}.${rawBody}`, else HMAC
 * over `rawBody`; compare with the re-hash `timingSafeEqual` trick.
 * `scheme: 'token'`: reject empty secret / missing header, then compare
 * `timingSafeEqual(sha256(secretBuf), sha256(providedBuf))`.
 */
/** Request context a `baseString` composer may fold into the signed base string
 *  (HubSpot signs method + public URL). Both default to safe values, so the
 *  common schemes ignore it. */
export interface VerifyContext {
  method?: string
  /** The PUBLIC delivered URL (HubSpot); NOT the loopback `req.url`. */
  requestUri?: string
}

export function verifyWebhookSignature(
  rawBody: Buffer,
  headers: IncomingHttpHeaders,
  verifier: WebhookVerifier,
  secret: string,
  now: () => number = Date.now,
  context: VerifyContext = {}
): boolean {
  // An empty signing secret makes the check forgeable by anyone who knows the
  // body — refuse it outright rather than "verify" against nothing.
  if (secret.length === 0) return false

  if (verifier.scheme === 'token') {
    const provided = headerValue(headers, verifier.header)
    if (typeof provided !== 'string' || provided.length === 0) return false
    return timingSafeMatch(Buffer.from(secret), Buffer.from(provided))
  }

  // scheme === 'hmac'
  const rawHeader = headerValue(headers, verifier.header)
  if (typeof rawHeader !== 'string' || rawHeader.length === 0) return false

  const parseHeader: (raw: string) => { signature: string; timestamp?: string } | null =
    verifier.parseHeader ?? ((raw) => ({ signature: raw }))
  const parsed = parseHeader(rawHeader)
  if (!parsed || typeof parsed.signature !== 'string' || parsed.signature.length === 0) {
    return false
  }

  const algo = verifier.algo ?? 'sha256'
  const encoding = verifier.encoding ?? 'hex'

  let ts = ''
  if (verifier.signsTimestamp) {
    // Prefer the timestamp parsed from the composite header (Stripe `t=`); fall
    // back to a dedicated timestamp header if configured (Slack, HubSpot).
    const resolved =
      typeof parsed.timestamp === 'string' && parsed.timestamp.length > 0
        ? parsed.timestamp
        : verifier.timestampHeader
          ? headerValue(headers, verifier.timestampHeader)
          : undefined
    if (typeof resolved !== 'string' || resolved.length === 0) return false
    const tsNum = Number(resolved)
    if (!Number.isFinite(tsNum)) return false
    // Normalize to seconds for the replay window (HubSpot sends milliseconds).
    const tsSec = verifier.timestampUnit === 'milliseconds' ? tsNum / 1000 : tsNum
    const tolerance = verifier.toleranceSec ?? DEFAULT_TOLERANCE_SEC
    const ageSec = Math.abs(now() / 1000 - tsSec)
    if (ageSec > tolerance) return false
    ts = resolved
  }

  // Compose the signed base string. Body-only (no composer, no timestamp) signs
  // the raw body BYTES directly (byte-exact — the Shopify/Woo/Linear path);
  // otherwise a composer (or the Stripe `${ts}.${body}` default) builds a string.
  let message: Buffer
  if (verifier.baseString) {
    message = Buffer.from(
      verifier.baseString({
        method: context.method ?? 'POST',
        requestUri: context.requestUri ?? '',
        timestamp: ts,
        rawBody: rawBody.toString('utf8')
      }),
      'utf8'
    )
  } else if (verifier.signsTimestamp) {
    message = Buffer.concat([Buffer.from(`${ts}.`, 'utf8'), rawBody])
  } else {
    message = rawBody
  }

  const expected = createHmac(algo, secret).update(message).digest()
  const providedBuf = Buffer.from(parsed.signature, encoding)
  return timingSafeMatch(expected, providedBuf)
}

/**
 * Start ONE loopback webhook receiver from config. The fixed pipeline is:
 *
 *   404 (method/path) → collect body (413 over cap, `responded`/error guard)
 *     → preVerify? → verify (raw body, BEFORE parse; 401 on fail)
 *     → dedup? → parse (400 on null) → 200-fast → setImmediate(deliver)
 */
export function startWebhookReceiver<E>(
  config: WebhookReceiverConfig<E>
): Promise<WebhookReceiver<E>> {
  const path = config.path
  const host = config.host ?? '127.0.0.1'
  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const log = config.log ?? ((m: string) => console.warn(m))
  let handler: ((event: E) => void) | null = null

  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== path) {
      res.writeHead(404)
      res.end()
      return
    }

    const chunks: Buffer[] = []
    let size = 0
    let responded = false
    // A mid-body reset emits 'error' on the request stream; with no listener
    // that crashes the main process. Mark responded so queued 'data'/'end'
    // never touch the dead socket.
    req.on('error', () => {
      responded = true
    })
    req.on('data', (chunk: Buffer) => {
      if (responded) return
      size += chunk.length
      if (size > maxBodyBytes) {
        responded = true
        res.writeHead(413)
        res.end()
        req.destroy()
        log(`webhook ${path}: rejected — body exceeds ${maxBodyBytes} bytes`)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (responded) return
      responded = true
      const rawBody = Buffer.concat(chunks)

      // Run the transport-agnostic verify→dedup→parse policy. `requestUri` is the
      // PUBLIC delivered URL (HubSpot signs it), falling back to the loopback path
      // — computed here and passed as `publicUrl` so the resolution is byte-for-
      // byte what the receiver used inline before.
      const out = handleWebhookDelivery(config, {
        rawBody,
        headers: req.headers,
        method: req.method ?? 'POST',
        publicUrl: config.publicUrl ?? req.url ?? ''
      })

      // Map the policy's status to the HTTP status the receiver wrote inline
      // before. 200-fast: commit the response BEFORE the connector does any heavy
      // work so the vendor's ack/response deadlines are met.
      res.writeHead(out.status)
      res.end()

      // Deliver ONLY a 200 that produced an event (a short-circuit 200 carries
      // none), on a later tick, inside the same try/catch as before.
      if (out.status !== 200 || out.event === undefined) return
      const event = out.event
      const deliver = handler
      if (!deliver) return
      setImmediate(() => {
        try {
          deliver(event)
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err)
          log(`webhook ${path}: handler failed — ${reason}`)
        }
      })
    })
  })

  applyLoopbackTimeouts(server)
  return new Promise((resolve) => {
    server.listen(config.port ?? 0, host, () => {
      const { port } = server.address() as AddressInfo
      resolve({
        port,
        onEvent: (h) => {
          handler = h
        },
        close: () => server.close()
      })
    })
  })
}
