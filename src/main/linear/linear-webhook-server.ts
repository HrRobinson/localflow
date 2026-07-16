import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { applyLoopbackTimeouts } from '../server-timeouts'
import type { LinearSessionAction, LinearSessionEvent } from '../../shared/linear'

/**
 * Receiver skeleton for Linear `AgentSessionEvent` webhooks (spec §4.4, §6.1).
 * Mirrors `hook-server.ts` — `createServer`, `applyLoopbackTimeouts`,
 * `MAX_BODY_BYTES`, a `responded` guard, a mid-body 'error' guard — and ADDS
 * the two things a cloud-origin webhook needs:
 *  - **HMAC signature verification** (timing-safe, over the raw body, against
 *    the webhook signing secret — never logged), exactly the `timingSafeEqual`
 *    discipline `hook-server.ts` / `operator-grant.ts` use.
 *  - a **200-fast** hot path: verify + parse, respond, THEN hand the event to
 *    the connector on a later tick — so the 10s ack contract and the webhook's
 *    ~5s response window are both met (spec §4.4).
 *
 * The connector wiring (spawn a pane, emit the ack `thought`) lives behind the
 * `onEvent` seam and is out of scope here (deferred). This module never trusts
 * the body's shape and never logs the secret or the body — only route+reason,
 * mirroring `control-api.ts`'s token discipline (spec §8).
 */

/** Cap on the raw webhook body. Generous vs `hook-server`'s 4 KB — a Linear
 *  payload carries an issue's `promptContext` — but still a hard ceiling. */
export const LINEAR_MAX_BODY_BYTES = 1_048_576

/** Header Linear signs the raw body with (hex HMAC-SHA256). */
export const LINEAR_SIGNATURE_HEADER = 'linear-signature'

const DEFAULT_PATH = '/linear/webhook'
const VALID_ACTIONS: ReadonlySet<string> = new Set<LinearSessionAction>(['created', 'prompted'])

export interface LinearWebhookOptions {
  /** The webhook signing secret. NEVER logged, echoed, or rendered. */
  secret: string
  /** Path the webhook posts to. Defaults to `/linear/webhook`. */
  path?: string
  /** Bind host — the dev tunnel forwards here (spec §4.4). Default 127.0.0.1. */
  host?: string
  /** Port; default 0 (ephemeral, resolved after listen). */
  port?: number
  /** Route+reason logger. NEVER receives the secret or the body. */
  log?: (message: string) => void
}

export interface LinearWebhookServer {
  port: number
  /** Register the single handler that receives verified, parsed events. */
  onEvent(handler: (event: LinearSessionEvent) => void): void
  close(): void
}

function sha256(input: Buffer): Buffer {
  return createHash('sha256').update(input).digest()
}

/**
 * Timing-safe HMAC check. Both sides are re-hashed with sha256 so
 * `timingSafeEqual` never throws on a length mismatch (the operator-grant /
 * hook-server trick) and a malformed hex signature simply fails to match.
 */
export function verifyLinearSignature(rawBody: Buffer, provided: unknown, secret: string): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false
  const expected = createHmac('sha256', secret).update(rawBody).digest()
  const providedBuf = Buffer.from(provided, 'hex')
  return timingSafeEqual(sha256(expected), sha256(providedBuf))
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** Best-effort extract of the human's reply on a `prompted` event. Linear's
 *  Developer-Preview shape is isolated here (spec §4.2): a top-level `prompt`
 *  or a nested `agentActivity.content.body`. */
function extractPrompt(data: Record<string, unknown>): string | undefined {
  const top = asString(data.prompt)
  if (top) return top
  const activity = data.agentActivity
  if (typeof activity === 'object' && activity !== null) {
    const content = (activity as Record<string, unknown>).content
    if (typeof content === 'object' && content !== null) {
      return asString((content as Record<string, unknown>).body)
    }
  }
  return undefined
}

/**
 * Validate a raw webhook body into a `LinearSessionEvent`, or `null` if the
 * shape is untrusted/unsupported. Pure and unit-testable in isolation, like
 * `parseHookBody`.
 */
export function parseLinearEvent(raw: string): LinearSessionEvent | null {
  try {
    const data: unknown = JSON.parse(raw)
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
    const d = data as Record<string, unknown>
    const action = d.action
    if (typeof action !== 'string' || !VALID_ACTIONS.has(action)) return null

    const session = d.agentSession
    if (typeof session !== 'object' || session === null || Array.isArray(session)) return null
    const s = session as Record<string, unknown>
    const id = asString(s.id)
    if (!id) return null

    const event: LinearSessionEvent = {
      action: action as LinearSessionAction,
      agentSession: { id }
    }

    const promptContext = asString(s.promptContext)
    if (promptContext) event.agentSession.promptContext = promptContext
    const sessionState = asString(s.state)
    if (sessionState) event.agentSession.state = sessionState

    const issue = s.issue
    if (typeof issue === 'object' && issue !== null && !Array.isArray(issue)) {
      const iss = issue as Record<string, unknown>
      const issueId = asString(iss.id)
      if (issueId) {
        event.agentSession.issue = { id: issueId }
        const identifier = asString(iss.identifier)
        if (identifier) event.agentSession.issue.identifier = identifier
        const title = asString(iss.title)
        if (title) event.agentSession.issue.title = title
      }
    }

    if (action === 'prompted') {
      const prompt = extractPrompt(d)
      if (prompt) event.prompt = prompt
    }

    return event
  } catch {
    return null
  }
}

export function startLinearWebhookServer(opts: LinearWebhookOptions): Promise<LinearWebhookServer> {
  const path = opts.path ?? DEFAULT_PATH
  const host = opts.host ?? '127.0.0.1'
  const log = opts.log ?? ((m: string) => console.warn(m))
  let handler: ((event: LinearSessionEvent) => void) | null = null

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
    // never touch the dead socket (mirrors hook-server.ts).
    req.on('error', () => {
      responded = true
    })
    req.on('data', (chunk: Buffer) => {
      if (responded) return
      size += chunk.length
      if (size > LINEAR_MAX_BODY_BYTES) {
        responded = true
        res.writeHead(413)
        res.end()
        req.destroy()
        log(`linear webhook ${path}: rejected — body exceeds ${LINEAR_MAX_BODY_BYTES} bytes`)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (responded) return
      responded = true
      const rawBody = Buffer.concat(chunks)

      if (!verifyLinearSignature(rawBody, req.headers[LINEAR_SIGNATURE_HEADER], opts.secret)) {
        res.writeHead(401)
        res.end()
        log(`linear webhook ${path}: rejected — signature verification failed`)
        return
      }

      const event = parseLinearEvent(rawBody.toString('utf8'))
      if (!event) {
        res.writeHead(400)
        res.end()
        log(`linear webhook ${path}: rejected — unsupported or malformed payload`)
        return
      }

      // 200 fast: commit the response before the connector does any heavy work
      // (pane spawn + ack thought) so the ack/response deadlines are met.
      res.writeHead(200)
      res.end()
      const deliver = handler
      if (!deliver) return
      setImmediate(() => {
        try {
          deliver(event)
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err)
          log(`linear webhook ${path}: handler failed for ${event.action} — ${reason}`)
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
