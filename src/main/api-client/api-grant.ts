import { randomUUID, createHash, timingSafeEqual } from 'node:crypto'

function sha256(input: string): Buffer {
  return createHash('sha256').update(input).digest()
}

/** What a resolved API token authorises: one environment, a fixed collection set. */
export interface ApiGrant {
  environment: number
  collections: ReadonlySet<string>
}

/**
 * Per-environment API-client grants (design §6). A grant mints a bearer secret
 * and names the COLLECTION SET it may send within — "act as this API's client",
 * not "make HTTP calls". The control API resolves an incoming token back to its
 * grant in CONSTANT TIME. Revocation drops it so the token stops resolving
 * immediately. All in-memory: the grant's lifetime is the session that holds it,
 * and nothing survives a restart.
 *
 * DELIBERATELY separate from `OperatorGrantStore`, with separate tokens: hanging
 * collection scope on the operator grant would silently give every operator
 * API-send capability. No token authenticates both surfaces.
 */
export class ApiGrantStore {
  private byEnv = new Map<number, { token: string; collections: Set<string> }>()

  /**
   * Re-granting an environment that already holds a grant returns the existing
   * token and leaves its collection scope untouched, even if `collectionIds`
   * differs. To change scope, `revoke()` then `grant()` again.
   */
  grant(environment: number, collectionIds: string[]): string {
    const existing = this.byEnv.get(environment)
    if (existing) return existing.token
    const token = randomUUID()
    this.byEnv.set(environment, { token, collections: new Set(collectionIds) })
    return token
  }

  revoke(environment: number): void {
    this.byEnv.delete(environment)
  }

  /** Constant-time token match; null when no grant currently holds it. */
  resolve(token: string): ApiGrant | null {
    if (typeof token !== 'string' || token.length === 0) return null
    const probe = sha256(token)
    let match: ApiGrant | null = null
    for (const [environment, grant] of this.byEnv) {
      if (timingSafeEqual(probe, sha256(grant.token))) {
        match = { environment, collections: new Set(grant.collections) }
      }
    }
    return match
  }

  isGranted(environment: number): boolean {
    return this.byEnv.has(environment)
  }

  scopeFor(environment: number): string[] | undefined {
    const grant = this.byEnv.get(environment)
    return grant ? [...grant.collections] : undefined
  }
}
