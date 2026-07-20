/**
 * Mints + caches the Salesforce access token (spec §8). Two server-to-server
 * forks are designed behind ONE seam — the `TokenMinter` interface:
 *  - **client-credentials** (MVP-pinned, spec §13.1): POST `grant_type=
 *    client_credentials` with the connected-app consumer secret → a token.
 *  - **JWT-bearer**: a signed assertion (`iss`/`sub`/`aud`) → a token, no stored
 *    shared secret (a keypair).
 * Which fork is live is decided where the real minter is CONSTRUCTED; the real
 * minter (the token-endpoint POST + JWT signing) is DEFERRED (spec §4.3) behind
 * this seam, so the caching / expiry / re-mint discipline is fully tested offline
 * with a mock minter (spec §12).
 *
 * The minted access token is cached IN-PROCESS with its expiry and NEVER written
 * to config.json / a log / an error / any IPC payload (spec §8) — it is read at
 * call time and used only as the `Authorization: Bearer` header inside
 * `salesforce-api`. The keychain credential (consumer secret / private key) is
 * read only inside the real minter, via `salesforce-token-store`, and is likewise
 * never rendered.
 */

/** A token-endpoint result. `instanceUrl` is the org's API host from the token
 *  response; `expiresInSeconds` bounds the in-process cache. */
export interface SalesforceTokenResult {
  accessToken: string
  instanceUrl?: string
  expiresInSeconds?: number
}

/** The auth-fork seam: the real impl POSTs to the token endpoint (client-creds or
 *  JWT-bearer); tests inject a mock. `mint()` NEVER returns anything but the token
 *  material it is asked for, and its errors carry the OAuth reason, never the
 *  secret value (spec §11). */
export interface TokenMinter {
  mint(): Promise<SalesforceTokenResult>
}

export interface SalesforceAuthDeps {
  minter: TokenMinter
  /** The injected clock (ms) — the same `flow-engine.now()` seam the poller uses. */
  now: () => number
  /** Re-mint this many seconds BEFORE the stated expiry (clock skew). Default 60. */
  skewSeconds?: number
  /** Default token lifetime (s) when the endpoint omits `expires_in`. Default 3600. */
  defaultTtlSeconds?: number
}

interface CachedToken {
  accessToken: string
  instanceUrl?: string
  expiresAt: number
}

/** Whether an error is Salesforce's expired-session signal (spec §11). The real
 *  api throws with `INVALID_SESSION_ID` in the message; a mock does the same. */
export function isInvalidSession(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /INVALID_SESSION_ID/i.test(msg)
}

export class SalesforceAuth {
  private readonly minter: TokenMinter
  private readonly now: () => number
  private readonly skewMs: number
  private readonly defaultTtlMs: number
  private cached: CachedToken | undefined
  /** Coalesce concurrent mints so a burst of first calls mints ONE token. */
  private inflight: Promise<CachedToken> | undefined

  constructor(deps: SalesforceAuthDeps) {
    this.minter = deps.minter
    this.now = deps.now
    this.skewMs = (deps.skewSeconds ?? 60) * 1000
    this.defaultTtlMs = (deps.defaultTtlSeconds ?? 3600) * 1000
  }

  /** The cached access token, minting (once) if absent/expired (spec §8). */
  async accessToken(): Promise<string> {
    return (await this.ensure()).accessToken
  }

  /** The org instance URL from the token response, if the endpoint returned one. */
  async instanceUrl(): Promise<string | undefined> {
    return (await this.ensure()).instanceUrl
  }

  /** Drop the cached token so the next call re-mints (disconnect / expiry). */
  invalidate(): void {
    this.cached = undefined
  }

  /**
   * Run `fn` with a valid access token, re-minting EXACTLY ONCE and retrying on a
   * `401 INVALID_SESSION_ID` before rejecting (spec §8, §11). This is the one
   * place the re-mint-once policy lives, so every `salesforce-api` call inherits
   * it without duplicating the logic.
   */
  async withAuth<T>(fn: (token: string) => Promise<T>): Promise<T> {
    const token = await this.accessToken()
    try {
      return await fn(token)
    } catch (err) {
      if (!isInvalidSession(err)) throw err
      // The session expired mid-call — re-mint ONCE and retry. A second failure
      // (or a non-session error) propagates with its real cause.
      this.invalidate()
      const fresh = await this.accessToken()
      return fn(fresh)
    }
  }

  private async ensure(): Promise<CachedToken> {
    const cur = this.cached
    if (cur && this.now() < cur.expiresAt - this.skewMs) return cur
    if (this.inflight) return this.inflight
    this.inflight = this.mint()
    try {
      const fresh = await this.inflight
      this.cached = fresh
      return fresh
    } finally {
      this.inflight = undefined
    }
  }

  private async mint(): Promise<CachedToken> {
    const result = await this.minter.mint()
    const ttl =
      result.expiresInSeconds !== undefined && result.expiresInSeconds > 0
        ? result.expiresInSeconds * 1000
        : this.defaultTtlMs
    return {
      accessToken: result.accessToken,
      instanceUrl: result.instanceUrl,
      expiresAt: this.now() + ttl
    }
  }
}

/**
 * The DEFERRED live minter (spec §4.3, §8). Registered at startup so the
 * connector/poller/api land first; a real auth attempt fails LOUDLY rather than
 * silently no-opping until the token-endpoint POST + JWT signing are wired. The
 * `fork` names which grant the live build will use (client-credentials MVP,
 * spec §13.1).
 */
export function deferredMinter(fork: 'client-credentials' | 'jwt-bearer'): TokenMinter {
  return {
    mint: () =>
      Promise.reject(
        new Error(
          `Salesforce live auth (${fork}) isn't wired yet — the token-endpoint POST and ` +
            'assertion signing land in a follow-up (spec §4.3). The offline connector core ' +
            '(descriptor, normalizer, poller, cursor store, api seam) is in place and mock-tested.'
        )
      )
  }
}
