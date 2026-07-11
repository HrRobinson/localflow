/**
 * Helpers for launching OpenClaw as an operator agent: flatten a grant to the
 * env the shipped skill reads, and track launched sessions so localflow revokes
 * a grant when the last launched OpenClaw session in an environment is gone —
 * but only if the launch created the grant (never one granted manually).
 */

/** v1 single-environment credential → the env vars the shipped CLI reads. */
export function credentialEnv(endpoint: string, token: string): Record<string, string> {
  return { LOCALFLOW_ENDPOINT: endpoint, LOCALFLOW_TOKEN: token }
}

export class OperatorLaunchTracker {
  private live = new Map<number, Set<string>>()
  private launchOwned = new Set<number>()

  /**
   * Record a launched OpenClaw session in `environment`. `wasGrantedBefore` is
   * whether the environment already had an operator BEFORE this launch granted
   * it — a launch only owns (and later revokes) a grant it created.
   */
  onLaunch(environment: number, sessionId: string, wasGrantedBefore: boolean): void {
    if (!wasGrantedBefore) this.launchOwned.add(environment)
    const set = this.live.get(environment) ?? new Set<string>()
    set.add(sessionId)
    this.live.set(environment, set)
  }

  /**
   * Note a tracked session as gone. Returns the environment to revoke (the last
   * launch-created session in it just closed) or null.
   */
  onClose(sessionId: string): number | null {
    for (const [env, set] of this.live) {
      if (!set.has(sessionId)) continue
      set.delete(sessionId)
      if (set.size === 0) {
        this.live.delete(env)
        if (this.launchOwned.delete(env)) return env
      }
      return null
    }
    return null
  }

  /** All currently-tracked launched session ids. */
  trackedIds(): string[] {
    return [...this.live.values()].flatMap((s) => [...s])
  }
}
