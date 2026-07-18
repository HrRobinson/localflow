import type { LiveConnector } from '../../shared/integrations'
import { HTTP_ACTION_IDS, NODE_ID_PARAM, type HttpActionId } from '../../shared/http'
import type { ResolvedRequest } from '../../shared/http'
import { HttpClient } from './http-client'
import { resolveRequest } from './http-node-config'
import { responseToContext } from './http-normalize'

/**
 * The generic HTTP `LiveConnector` (spec §4.2) — live dispatch behind the
 * registry's pinned `invokeAction`/`subscribe`. It maps `http.get` / `http.send`
 * → a per-node resolved request → the SSRF-guarded `HttpClient`, revealing the
 * node's secret (main-only) under the COMPOSITE keychain key
 * `http:<nodeId>:<secretRef>` (§7) and applying it to the request headers. It
 * holds NO secret and NO vendor shape: reads/writes normalize through
 * `http-normalize.ts`, and every failure REJECTS with the real cause — never a
 * token, never a sentinel-success (§6.2, §9, §11).
 *
 * Authority stays in the graph: an `http.send` mutation only runs because an
 * `action` node invoked it, behind whatever `gate` the author drew (§11). The
 * connector never auto-sends.
 *
 * Split-ship: the OUTGOING half (`http.get`/`http.send`) is GREEN and shipped
 * here. The INCOMING `webhook.received` trigger is Half 2 (§13) — it needs the
 * per-node subscribe-seam extension (§4.4) + cloud ingress, so `subscribe`
 * currently registers a legible deferred no-op rather than a silent dead stream.
 */

const isActionId = (v: string): v is HttpActionId =>
  (HTTP_ACTION_IDS as readonly string[]).includes(v)

/** Reveal a per-node secret via the COMPOSITE keychain key
 *  `http:<nodeId>:<secretRef>` (§7) — backed main-only by `HttpTokenStore`; a
 *  fake is injected in tests. The plaintext exit itself lives in the token store,
 *  never here. */
export type RevealNodeSecret = (nodeId: string, secretRef: string) => string

export class HttpConnector implements LiveConnector {
  private readonly client: HttpClient
  private readonly reveal: RevealNodeSecret
  private readonly log: (message: string) => void

  constructor(deps: { client: HttpClient; reveal: RevealNodeSecret; log?: (m: string) => void }) {
    this.client = deps.client
    this.reveal = deps.reveal
    this.log = deps.log ?? ((m) => console.warn(m))
  }

  // ── Action dispatch (outgoing, GREEN) ────────────────────────────────────────

  async invokeAction(actionId: string, params: Record<string, unknown>): Promise<unknown> {
    if (!isActionId(actionId)) {
      throw new Error(
        `HTTP connector has no action '${actionId}'. Valid actions: ${HTTP_ACTION_IDS.join(', ')}.`
      )
    }
    const request = resolveRequest(actionId, params)
    const authed = this.applyAuth(request, this.nodeId(params))
    const res = await this.client.send(authed)
    return responseToContext(res)
  }

  /** The node id the action-runner injected (§7.3) — needed for the composite
   *  keychain key. Absent ⇒ a legible reject (a secret can't be located). */
  private nodeId(params: Record<string, unknown>): string {
    const id = params[NODE_ID_PARAM]
    if (typeof id === 'string' && id.length > 0) return id
    throw new Error(
      'http node is missing its node id — the per-node secret key `http:<nodeId>:<secretRef>` ' +
        "can't be built. This is an internal wiring error; report it."
    )
  }

  /** Reveal the per-node secret (main-only) and apply it to the request headers
   *  per the auth scheme. The secret NEVER appears in a log, an error, or the
   *  resolved request that is echoed anywhere (§9). */
  private applyAuth(request: ResolvedRequest, nodeId: string): ResolvedRequest {
    const { scheme, header, secretRef } = request.auth
    if (scheme === 'none' || secretRef === undefined) return request

    const secret = this.reveal(nodeId, secretRef)
    const headers = { ...request.headers }
    switch (scheme) {
      case 'bearer':
        headers['authorization'] = `Bearer ${secret}`
        break
      case 'basic':
        headers['authorization'] = `Basic ${Buffer.from(secret).toString('base64')}`
        break
      case 'header':
        headers[header ?? 'authorization'] = secret
        break
    }
    return { ...request, headers }
  }

  // ── Trigger subscription (incoming — Half 2, deferred) ───────────────────────

  subscribe(triggerId: string, handler: (event: unknown) => void): () => void {
    void handler // Half 2: no per-node subscribe-seam yet, so nothing to wire.
    this.log(
      `http connector: '${triggerId}' is the incoming webhook trigger (Half 2) — it needs the ` +
        'per-node subscribe-seam extension (§4.4) and cloud ingress, not wired in this build yet. ' +
        'No run will be seeded until it lands.'
    )
    return () => {}
  }
}
