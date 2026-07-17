import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { applyLoopbackTimeouts } from '../server-timeouts'

/**
 * SKELETON Shopify webhook receiver (spec §4.4, §7). Mirrors `hook-server.ts` /
 * `linear-webhook-server.ts` — `createServer`, `applyLoopbackTimeouts`,
 * `MAX_BODY_BYTES`, `responded` guard, mid-body 'error' guard, 200-fast hot path
 * — and ADDS what a cloud-origin Shopify webhook needs:
 *  - **HMAC-SHA256** verification over the RAW body (`X-Shopify-Hmac-Sha256`,
 *    base64), timing-safe, against the keychain webhook secret — verified BEFORE
 *    parsing (a body-parser that drains the stream first would break it, §2.2).
 *  - **`X-Shopify-Webhook-Id` dedup** so Shopify's expected redelivery never
 *    seeds a second run (200-dedup — spec §11). The dedup set lives HERE because
 *    the 200-vs-emit decision is made at the HTTP layer.
 *  - **200 fast**, then deliver on a later tick, so Shopify's delivery timeout is
 *    met and a slow flow never triggers a redelivery storm (spec §4.4).
 *
 * It NEVER trusts the body's shape, NEVER logs the secret or the body (only
 * route + reason — the `control-api.ts` token discipline), and does no live
 * tunnel/ingress work (deferred). The connector maps a delivered topic → trigger
 * ids and normalizes the payload (`shopify-normalize.ts`).
 */

/** Generous cap on the raw body — an order payload is larger than a hook ping. */
export const SHOPIFY_MAX_BODY_BYTES = 1_048_576

export const SHOPIFY_HMAC_HEADER = 'x-shopify-hmac-sha256'
export const SHOPIFY_TOPIC_HEADER = 'x-shopify-topic'
export const SHOPIFY_WEBHOOK_ID_HEADER = 'x-shopify-webhook-id'

const DEFAULT_PATH = '/shopify/webhook'

/** A verified, novel delivery handed to the connector. `payload` is the parsed,
 *  still-untrusted JSON body — the connector normalizes it (§4.2). */
export interface ShopifyWebhookDelivery {
  webhookId: string
  topic: string
  payload: Record<string, unknown>
}

export interface ShopifyWebhookOptions {
  /** The webhook signing secret (keychain-sourced). NEVER logged or rendered. */
  secret: string
  path?: string
  host?: string
  port?: number
  /** Route+reason logger — NEVER receives the secret or the body. */
  log?: (message: string) => void
}

export interface ShopifyWebhookServer {
  port: number
  onEvent(handler: (delivery: ShopifyWebhookDelivery) => void): void
  close(): void
}

function sha256(input: Buffer): Buffer {
  return createHash('sha256').update(input).digest()
}

/**
 * Timing-safe HMAC-SHA256 check over the raw body. Both sides are re-hashed with
 * sha256 so `timingSafeEqual` never throws on a length mismatch and a malformed
 * base64 signature simply fails to match. An empty secret is refused outright
 * (an empty-key HMAC is forgeable by anyone who knows the body).
 */
export function verifyShopifySignature(
  rawBody: Buffer,
  provided: unknown,
  secret: string
): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false
  if (secret.length === 0) return false
  const expected = createHmac('sha256', secret).update(rawBody).digest()
  const providedBuf = Buffer.from(provided, 'base64')
  return timingSafeEqual(sha256(expected), sha256(providedBuf))
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function header(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? ''
  return value ?? ''
}

export function startShopifyWebhookServer(
  opts: ShopifyWebhookOptions
): Promise<ShopifyWebhookServer> {
  const path = opts.path ?? DEFAULT_PATH
  const host = opts.host ?? '127.0.0.1'
  const log = opts.log ?? ((m: string) => console.warn(m))
  const seenWebhookIds = new Set<string>()
  let handler: ((delivery: ShopifyWebhookDelivery) => void) | null = null

  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== path) {
      res.writeHead(404)
      res.end()
      return
    }

    const chunks: Buffer[] = []
    let size = 0
    let responded = false
    req.on('error', () => {
      responded = true
    })
    req.on('data', (chunk: Buffer) => {
      if (responded) return
      size += chunk.length
      if (size > SHOPIFY_MAX_BODY_BYTES) {
        responded = true
        res.writeHead(413)
        res.end()
        req.destroy()
        log(`shopify webhook ${path}: rejected — body exceeds ${SHOPIFY_MAX_BODY_BYTES} bytes`)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (responded) return
      responded = true
      const rawBody = Buffer.concat(chunks)

      // Verify BEFORE parsing — never trust an unauthenticated body's shape.
      if (!verifyShopifySignature(rawBody, req.headers[SHOPIFY_HMAC_HEADER], opts.secret)) {
        res.writeHead(401)
        res.end()
        log(`shopify webhook ${path}: rejected — HMAC verification failed`)
        return
      }

      // Dedup on the webhook id — Shopify redelivery is expected; 200 + drop.
      const webhookId = header(req.headers[SHOPIFY_WEBHOOK_ID_HEADER])
      if (webhookId.length > 0 && seenWebhookIds.has(webhookId)) {
        res.writeHead(200)
        res.end()
        log(`shopify webhook ${path}: duplicate ${webhookId} — dropped`)
        return
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(rawBody.toString('utf8'))
      } catch {
        res.writeHead(400)
        res.end()
        log(`shopify webhook ${path}: rejected — malformed JSON body`)
        return
      }
      if (!isObj(parsed)) {
        res.writeHead(400)
        res.end()
        log(`shopify webhook ${path}: rejected — body is not a JSON object`)
        return
      }

      if (webhookId.length > 0) seenWebhookIds.add(webhookId)

      // 200 fast, then deliver on a later tick so the run never blocks the ack.
      res.writeHead(200)
      res.end()
      const deliver = handler
      if (!deliver) return
      const delivery: ShopifyWebhookDelivery = {
        webhookId,
        topic: header(req.headers[SHOPIFY_TOPIC_HEADER]),
        payload: parsed
      }
      setImmediate(() => {
        try {
          deliver(delivery)
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err)
          log(`shopify webhook ${path}: handler failed for ${delivery.topic} — ${reason}`)
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
