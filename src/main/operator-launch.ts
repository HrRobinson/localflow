/**
 * Helpers for launching OpenClaw as an operator agent: flatten a grant to the
 * env the shipped skill reads, and track launched sessions so saiife revokes
 * a grant when the last launched OpenClaw session in an environment is gone —
 * but only if the launch created the grant (never one granted manually).
 */

/** v1 single-environment credential → the env vars the shipped CLI reads. */
export function credentialEnv(endpoint: string, token: string): Record<string, string> {
  return { SAIIFE_ENDPOINT: endpoint, SAIIFE_TOKEN: token }
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

  /**
   * A tracked session's pty exited or was closed (the durable session itself
   * remains). Only acts when `revokeOnExit` (the opt-in config.json flag) is
   * on: returns the environment to revoke when it is launch-owned and no
   * other tracked session in it is still live per `isLive` — or null.
   * Ownership is consumed on revoke (like onClose), so a later manual grant
   * is never torn down by this session's eventual deletion.
   */
  onPtyExit(
    sessionId: string,
    isLive: (id: string) => boolean,
    revokeOnExit: boolean
  ): number | null {
    if (!revokeOnExit) return null
    for (const [env, set] of this.live) {
      if (!set.has(sessionId)) continue
      if (!this.launchOwned.has(env)) return null
      for (const id of set) {
        if (id !== sessionId && isLive(id)) return null
      }
      this.launchOwned.delete(env)
      return env
    }
    return null
  }

  /** All currently-tracked launched session ids. */
  trackedIds(): string[] {
    return [...this.live.values()].flatMap((s) => [...s])
  }
}
