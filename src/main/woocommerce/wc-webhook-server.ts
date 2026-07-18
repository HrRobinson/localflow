import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { applyLoopbackTimeouts } from '../server-timeouts'
import { normalizeOrder } from './wc-normalize'
import type { WcTriggerPayload } from '../../shared/woocommerce'

/**
 * Receiver SKELETON for WooCommerce webhooks (spec §4.4, §6.1). Mirrors
 * `hook-server.ts` / `linear-webhook-server.ts` — `createServer`,
 * `applyLoopbackTimeouts`, a body-size cap, a `responded` guard, a mid-body
 * 'error' guard — and ADDS the WooCommerce specifics:
 *  - **WC HMAC verification**: `X-WC-Webhook-Signature` is base64 (NOT hex like
 *    Linear) HMAC-SHA256 over the RAW body, compared TIMING-SAFELY against a
 *    locally computed digest (spec §2.3). The secret is never logged.
 *  - **Ping handling**: on webhook creation WC sends a ping with no
 *    `X-WC-Webhook-Topic` — the receiver 200s it WITHOUT spawning a run (§2.3).
 *  - **200-fast**: verify + parse, respond, THEN hand the normalized event to
 *    the connector on a later tick so WC never disables the webhook for slow
 *    delivery (spec §2.3, §4.4).
 *
 * Real cloud ingress (a dev tunnel / hosted relay registering the delivery URL)
 * is DEFERRED (spec §4.4, §11); this module is the verified-receiver core.
 */

/** Cap on the raw webhook body. Generous but a hard ceiling (matches Linear). */
export const WC_MAX_BODY_BYTES = 1_048_576

/** Header WC signs the raw body with (base64 HMAC-SHA256). */
export const WC_SIGNATURE_HEADER = 'x-wc-webhook-signature'
/** Topic header (`order.created`, …). Absent ⇒ a ping/handshake (spec §2.3). */
export const WC_TOPIC_HEADER = 'x-wc-webhook-topic'
/** Per-delivery id — the idempotency key seeded as `eventId` (spec §4.5). */
export const WC_DELIVERY_ID_HEADER = 'x-wc-webhook-delivery-id'

const DEFAULT_PATH = '/woocommerce/webhook'

/** The verified, normalized event handed to the connector. */
export interface WcWebhookEvent {
  topic: string
  deliveryId?: string
  payload: WcTriggerPayload
}

export interface WcWebhookOptions {
  /** The webhook signing secret. NEVER logged, echoed, or rendered (spec §5). */
  secret: string
  path?: string
  host?: string
  port?: number
  /** Route+reason logger. NEVER receives the secret or the body (spec §8). */
  log?: (message: string) => void
}

export interface WcWebhookServer {
  port: number
  onEvent(handler: (event: WcWebhookEvent) => void): void
  close(): void
}

function sha256(input: Buffer): Buffer {
  return createHash('sha256').update(input).digest()
}

/**
 * Timing-safe WC HMAC check (spec §2.3). Both sides are re-hashed with sha256 so
 * `timingSafeEqual` never throws on a length mismatch (the operator-grant /
 * hook-server trick) and a malformed base64 signature simply fails to match. An
 * empty secret is refused outright rather than "verified" against nothing.
 */
export function verifyWcSignature(rawBody: Buffer, provided: unknown, secret: string): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false
  if (secret.length === 0) return false
  const expected = createHmac('sha256', secret).update(rawBody).digest()
  const providedBuf = Buffer.from(provided, 'base64')
  return timingSafeEqual(sha256(expected), sha256(providedBuf))
}

function header(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

/**
 * Validate a raw WC order body into a normalized payload, or `null` if the shape
 * is untrusted/unusable (no order id). Pure + unit-testable, like `parseHookBody`.
 */
export function parseWcOrderBody(raw: string): WcTriggerPayload | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  const payload = normalizeOrder(data)
  // An order with no id is not an order we can act on — reject at the boundary.
  if (payload.order.id.length === 0) return null
  return payload
}

export function startWcWebhookServer(opts: WcWebhookOptions): Promise<WcWebhookServer> {
  const path = opts.path ?? DEFAULT_PATH
  const host = opts.host ?? '127.0.0.1'
  const log = opts.log ?? ((m: string) => console.warn(m))
  let handler: ((event: WcWebhookEvent) => void) | null = null

  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== path) {
      res.writeHead(404)
      res.end()
      return
    }

    const chunks: Buffer[] = []
    let size = 0
    let responded = false
    // A mid-body reset emits 'error'; with no listener that crashes the main
    // process. Mark responded so queued 'data'/'end' never touch a dead socket.
    req.on('error', () => {
      responded = true
    })
    req.on('data', (chunk: Buffer) => {
      if (responded) return
      size += chunk.length
      if (size > WC_MAX_BODY_BYTES) {
        responded = true
        res.writeHead(413)
        res.end()
        req.destroy()
        log(`woo webhook ${path}: rejected — body exceeds ${WC_MAX_BODY_BYTES} bytes`)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (responded) return
      responded = true
      const rawBody = Buffer.concat(chunks)

      // A ping/handshake carries no topic header — 200 it, spawn NO run (§2.3).
      const topic = header(req.headers[WC_TOPIC_HEADER])
      if (!topic) {
        res.writeHead(200)
        res.end()
        log(`woo webhook ${path}: ping acknowledged (no topic) — no run seeded`)
        return
      }

      if (!verifyWcSignature(rawBody, req.headers[WC_SIGNATURE_HEADER], opts.secret)) {
        res.writeHead(401)
        res.end()
        log(`woo webhook ${path}: rejected — signature verification failed`)
        return
      }

      const payload = parseWcOrderBody(rawBody.toString('utf8'))
      if (!payload) {
        res.writeHead(400)
        res.end()
        log(`woo webhook ${path}: rejected — unsupported or malformed order payload`)
        return
      }

      // 200 fast: commit the response BEFORE the connector does any work so WC's
      // ~5s response window is met and the webhook is never disabled (§2.3).
      res.writeHead(200)
      res.end()
      const deliver = handler
      if (!deliver) return
      const event: WcWebhookEvent = { topic, payload }
      const deliveryId = header(req.headers[WC_DELIVERY_ID_HEADER])
      if (deliveryId) event.deliveryId = deliveryId
      setImmediate(() => {
        try {
          deliver(event)
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err)
          log(`woo webhook ${path}: handler failed for ${topic} — ${reason}`)
        }
      })
    })
  })

  applyLoopbackTimeouts(server)
  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, host, () => {
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
