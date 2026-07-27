/**
 * Which pane holds the API grant for each environment, and the collection set
 * it was minted with.
 *
 * `OperatorLaunchTracker` was considered and rejected: its semantics are
 * operator-specific (it tracks whether saiife LAUNCHED the pane, and carries a
 * `revokeOnExit` config flag). This answers a different, simpler question, so
 * bending that module would make one module serve two masters.
 *
 * The binding records which pane holds each environment's grant. The grant is
 * revoked when that pane is DELETED, not merely exited — reconciled in
 * `index.ts` via `manager.onSessionsChanged`. The collection set is retained
 * alongside the pane id so `apiGrantStatus` can report scope without a second
 * lookup.
 */

export interface ApiGrantBindingRecord {
  paneId: string
  collectionIds: string[]
}

export class ApiGrantBinding {
  private byEnv = new Map<number, ApiGrantBindingRecord>()

  /** Bind an environment's grant to a pane. Replaces any existing binding —
   *  `ApiGrantStore` mints one token per environment, so a second grant MOVES
   *  the capability rather than adding one. */
  bind(environment: number, paneId: string, collectionIds: string[]): void {
    this.byEnv.set(environment, { paneId, collectionIds: [...collectionIds] })
  }

  unbind(environment: number): void {
    this.byEnv.delete(environment)
  }

  get(environment: number): ApiGrantBindingRecord | undefined {
    const record = this.byEnv.get(environment)
    return record ? { paneId: record.paneId, collectionIds: [...record.collectionIds] } : undefined
  }

  /** The environment this pane holds the grant for, or null. */
  environmentForPane(paneId: string): number | null {
    for (const [environment, record] of this.byEnv) {
      if (record.paneId === paneId) return environment
    }
    return null
  }

  /** The environments that currently hold a grant. Used by the delete hook to
   *  reconcile bindings against the live session list. */
  environments(): number[] {
    return [...this.byEnv.keys()]
  }
}
