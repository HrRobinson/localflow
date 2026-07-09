import type { Watchpoint } from '../shared/operator'

/** Registry of workflow watchpoints. Fleshed out in Layer 4. */
export interface WatchpointRegistry {
  register(environment: number, body: Record<string, unknown>): Watchpoint | null
  list(environment: number): Watchpoint[]
  markHit(id: string): void
}
