import type { ResponseView } from '../../shared/api-client'
import { SsrfGuardError, type HttpClient } from '../http/http-client'
import { applyAuth } from '../http/apply-auth'
import { resolveRequest } from '../http/http-node-config'
import type { ApiGrant } from './api-grant'
import type { CollectionSecretStore } from './collection-secrets'
import type { CollectionStore } from './collection-store'
import { chainScrubCandidates, scrub, scrubForms } from './redact'
import {
  resolveSendInput,
  type RefResolver,
  type RefValue,
  type SendInput
} from './request-resolve'
import type { ResponseStore } from './response-store'

/**
 * Send orchestration (design §3) — the ONE place a collection credential is
 * revealed and applied. Everything upstream holds only a `secretRef`; everything
 * downstream holds only a scrubbed body.
 *
 * Uses `HttpClient.sendRaw`, NOT `send`: a non-2xx is a normal result the agent
 * must iterate on, and `send`'s rejection embeds a body excerpt that would route
 * raw response content around the shape/withhold model (§7).
 *
 * Every failure is a `{ ok: false, status, error }` value rather than a throw, so
 * the route maps it without a second try/catch — and the error text NEVER
 * contains a secret.
 */

export type SendResult =
  { ok: true; view: ResponseView } | { ok: false; status: number; error: string }

/** One wording for "not yours", whether it is out of scope, foreign, or absent —
 *  never leak a foreign collection's existence (mirrors `unknown group`). */
const NO_COLLECTION = 'unknown collection'

export class ApiSender {
  private readonly collections: CollectionStore
  private readonly secrets: CollectionSecretStore
  private readonly client: HttpClient
  private readonly responses: ResponseStore

  constructor(deps: {
    collections: CollectionStore
    secrets: CollectionSecretStore
    client: HttpClient
    responses: ResponseStore
  }) {
    this.collections = deps.collections
    this.secrets = deps.secrets
    this.client = deps.client
    this.responses = deps.responses
  }

  async send(grant: ApiGrant, input: SendInput): Promise<SendResult> {
    // C1 belt-and-braces: every error string this method returns is scrubbed
    // through the SAME set `ingest` would use, computed from whatever of
    // `secret`/`refValues` is known at the point of failure (both start
    // empty, so a pre-reveal failure scrubs nothing — there is nothing yet TO
    // scrub). This does not replace the primary fix (`sendRaw` never
    // interpolating `err.message`) — it is the second, independent layer: if
    // a withheld value ever reached an error string by any path, it still
    // never reaches the agent.
    let secret = ''
    let refValues: RefValue[] = []
    const scrubSet = (): string[] => [
      ...scrubForms(secret),
      ...chainScrubCandidates(refValues).flatMap(scrubForms)
    ]
    const fail = (status: number, message: string): SendResult => ({
      ok: false,
      status,
      error: scrub(message, scrubSet())
    })

    if (!grant.collections.has(input.collectionId)) {
      return fail(403, NO_COLLECTION)
    }
    const collection = this.collections.get(input.collectionId, grant.environment)
    if (collection === undefined) {
      return fail(403, NO_COLLECTION)
    }

    // Resolution + the EXISTING validator. Both throw legibly at the boundary;
    // neither has ever seen a secret.
    //
    // `resolveRef` backs `$ref` chaining (design §4.4): scoped to THIS grant
    // (environment AND collection set — C2), so a ref can never reach
    // another environment's response, nor a response left over from a
    // DIFFERENT grant that used to hold this same environment (a revoked and
    // re-minted grant, the normal "move the capability to another agent"
    // workflow). It deliberately bypasses `pull`'s withheld gate via
    // `pullForChain` — passing a value through is not the same as an agent
    // reading it — but still refuses a container, and an unknown/evicted/
    // out-of-scope response, uniformly as "no longer held, re-send" so the
    // refusal itself never distinguishes those cases for the agent.
    const resolveRef: RefResolver = (responseId, path) => {
      const pulled = this.responses.pullForChain(responseId, grant, path)
      if (pulled.ok) return { ok: true, value: String(pulled.value), withheld: pulled.withheld }
      // `null` gets its own wording (finding 4) — it is not "no longer held",
      // it is a value that was never there to chain in the first place, and
      // conflating the two would make a genuinely-evicted response look like
      // a null field or vice versa.
      return {
        ok: false,
        reason:
          pulled.reason === 'null'
            ? 'that field is null — there is no value to chain'
            : 'no longer held, re-send'
      }
    }

    let request
    try {
      const resolved = resolveSendInput(collection, input, resolveRef)
      refValues = resolved.refValues

      // Finding 1, wave 3 (elide, don't exempt — see `request-resolve.ts`):
      // `resolveRequest`'s header validation (`looksLikeSecretLiteral` in
      // `resolveHeaders`) exists to catch an agent HARDCODING a real
      // credential into `config.headers` — the opposite of a `$ref`-chained
      // value, which the agent never saw. `resolved.elidedHeaderValues` maps
      // every header to its value with any `$ref`-derived span blanked;
      // passed as an explicit parameter (never smuggled through `params`,
      // which is otherwise agent-controlled) so `resolveHeaders` checks the
      // AGENT-AUTHORED portion of every header, always — none is ever
      // skipped, so an agent literal riding alongside a chained span in the
      // very SAME header is still refused.
      request = resolveRequest(resolved.actionId, resolved.params, resolved.elidedHeaderValues)
    } catch (err) {
      return fail(400, (err as Error).message)
    }

    // The single reveal. Kept as narrow as possible: read at call time, applied
    // immediately, never stored on `this`.
    if (request.auth.scheme !== 'none' && request.auth.secretRef !== undefined) {
      try {
        secret = this.secrets.revealSecret(collection.id, request.auth.secretRef)
      } catch (err) {
        return fail(400, (err as Error).message)
      }
    }

    const started = Date.now()
    let raw
    try {
      raw = await this.client.sendRaw(secret === '' ? request : applyAuth(request, secret))
    } catch (err) {
      // `sendRaw` rejects only for the SSRF guard or a transport failure, and
      // neither is meant to ever contain the secret or a chained withheld
      // value — `fail` scrubs it anyway (C1 belt-and-braces). The two are
      // distinguished: a guard rejection is a bad REQUEST (400, and retrying
      // it can never succeed), a transport failure is a bad UPSTREAM (502,
      // worth a retry).
      const status = err instanceof SsrfGuardError ? 400 : 502
      return fail(status, (err as Error).message)
    }

    return {
      ok: true,
      view: this.responses.ingest({
        environment: grant.environment,
        collectionId: collection.id,
        status: raw.status,
        durationMs: Date.now() - started,
        headers: raw.headers,
        body: raw.body,
        // Every WITHHELD value chained in via `$ref` joins the scrub set too
        // — without this, a chained withheld token could come right back in
        // THIS response's echoed body (exactly the leak §4.1's withhold tier
        // exists to prevent). `chainScrubCandidates` (finding 2) filters on
        // withheld-ness, not length — a value that was never withheld was
        // already readable from the response it came from, so scrubbing it
        // here protects nothing. `refValues` itself (finding 3) already
        // excludes anything that never actually reached this request (e.g. a
        // body ref on a GET, whose body `resolveRequest` drops entirely), so
        // this list is exactly "chained, sent, and withheld at the source".
        secrets: scrubSet()
      })
    }
  }
}
