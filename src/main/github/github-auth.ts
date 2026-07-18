import { createSign } from 'node:crypto'

/**
 * Credential → request-auth resolution (§8). Two real paths:
 *
 *  - **PAT (MVP "for me").** The fine-grained token is passed straight through as
 *    `Authorization: Bearer <pat>`, read at call time via the injected `reveal`
 *    seam (bound, at live wiring, to the CredentialStore's main-only keychain
 *    reveal exit for the `github` / `pat` field).
 *  - **GitHub App installation (recommended default).** Sign a short-lived JWT
 *    (`iss=appId`, ≤10-min expiry) with the App private key, exchange it for a
 *    1-hour installation access token (cached IN MEMORY only — never persisted),
 *    refresh it before expiry, and return `Authorization: Bearer <token>`. The
 *    connector then acts as the App's own bot identity.
 *
 * The never-render-secrets rule is absolute here: neither the PAT, the App
 * private key, nor the minted installation token is EVER placed in a log, an
 * error message, or a returned value other than the opaque header — a no-leak
 * test asserts it across every path (§8, §11, §12).
 */

export interface GitHubAuth {
  /** Resolve the `Authorization` header value, e.g. `Bearer <token>`. */
  authHeader(): Promise<string>
}

// ── PAT ──────────────────────────────────────────────────────────────────────

export class PatAuth implements GitHubAuth {
  constructor(private readonly reveal: () => string) {}

  authHeader(): Promise<string> {
    return Promise.resolve(`Bearer ${this.reveal()}`)
  }
}

// ── GitHub App installation ────────────────────────────────────────────────

/** The token-mint transport seam — the only network touch in the App path. Wired
 *  live to a POST `…/app/installations/{id}/access_tokens`; a mock in tests. */
export type InstallationTokenMinter = (req: {
  appJwt: string
  installationId: string
}) => Promise<{ token: string; expiresAt: string }>

export interface AppAuthDeps {
  appId: string
  installationId: string
  /** Main-only plaintext exit for the PEM private key (never stored here). */
  revealPrivateKey: () => string
  mint: InstallationTokenMinter
  /** Injectable clock for deterministic expiry tests. */
  now?: () => number
  /** Refresh the token this many ms BEFORE its real expiry (default 60s). */
  refreshSkewMs?: number
}

export class AppAuth implements GitHubAuth {
  private readonly deps: AppAuthDeps
  private readonly now: () => number
  private readonly refreshSkewMs: number
  private cached: { token: string; expiresAtMs: number } | null = null

  constructor(deps: AppAuthDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.refreshSkewMs = deps.refreshSkewMs ?? 60_000
  }

  async authHeader(): Promise<string> {
    const token = await this.installationToken()
    return `Bearer ${token}`
  }

  /** Drop the in-memory token (e.g. on disconnect / re-auth). */
  invalidate(): void {
    this.cached = null
  }

  private async installationToken(): Promise<string> {
    if (this.cached && this.now() < this.cached.expiresAtMs - this.refreshSkewMs) {
      return this.cached.token
    }
    let minted: { token: string; expiresAt: string }
    try {
      minted = await this.deps.mint({
        appJwt: this.signJwt(),
        installationId: this.deps.installationId
      })
    } catch (err) {
      // Never render the key or the JWT — surface only the actionable reason.
      throw new Error(
        'Could not mint a GitHub App installation token — check the App id / private key / ' +
          `installation id in Settings (${(err as Error).message}).`,
        { cause: err }
      )
    }
    const expiresAtMs = Date.parse(minted.expiresAt)
    this.cached = {
      token: minted.token,
      expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : this.now() + 3_600_000
    }
    return minted.token
  }

  /** Sign a short-lived RS256 JWT with the App private key (§8). */
  private signJwt(): string {
    const iat = Math.floor(this.now() / 1000) - 30 // clock-skew allowance
    const exp = iat + 9 * 60 // ≤10-min expiry
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    const payload = base64url(JSON.stringify({ iat, exp, iss: this.deps.appId }))
    const signingInput = `${header}.${payload}`
    let signature: string
    try {
      const signer = createSign('RSA-SHA256')
      signer.update(signingInput)
      signer.end()
      signature = signer.sign(this.deps.revealPrivateKey(), 'base64')
    } catch (err) {
      // A bad/garbled PEM must fail legibly WITHOUT echoing the key.
      throw new Error(
        `The stored GitHub App private key couldn't sign a token (${(err as Error).message}) — ` +
          're-enter the PEM in Settings.',
        { cause: err }
      )
    }
    return `${signingInput}.${base64urlFromBase64(signature)}`
  }
}

function base64url(input: string): string {
  return base64urlFromBase64(Buffer.from(input, 'utf8').toString('base64'))
}

function base64urlFromBase64(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
