import { randomUUID, createHash, timingSafeEqual } from 'node:crypto'

function sha256(input: string): Buffer {
  return createHash('sha256').update(input).digest()
}

interface Grant {
  token: string
  connected: boolean
}

/**
 * Per-environment operator grants. At most one operator per environment (v1):
 * a grant mints a bearer secret; the control API resolves an incoming token
 * back to its environment in constant time. Revocation drops the grant so the
 * token stops resolving immediately (spec: "Revoking it immediately invalidates
 * the operator's access"). All in-memory — grants do not survive a restart.
 */
export class OperatorGrantStore {
  private byEnv = new Map<number, Grant>()

  grant(environment: number): string {
    const existing = this.byEnv.get(environment)
    if (existing) return existing.token
    const token = randomUUID()
    this.byEnv.set(environment, { token, connected: false })
    return token
  }

  revoke(environment: number): void {
    this.byEnv.delete(environment)
  }

  /** Constant-time token match; null when no grant currently holds it. */
  environmentForToken(token: string): number | null {
    if (typeof token !== 'string' || token.length === 0) return null
    const probe = sha256(token)
    for (const [env, grant] of this.byEnv) {
      if (timingSafeEqual(probe, sha256(grant.token))) return env
    }
    return null
  }

  isGranted(environment: number): boolean {
    return this.byEnv.has(environment)
  }

  markConnected(environment: number): void {
    const g = this.byEnv.get(environment)
    if (g) g.connected = true
  }

  isConnected(environment: number): boolean {
    return this.byEnv.get(environment)?.connected ?? false
  }
}
