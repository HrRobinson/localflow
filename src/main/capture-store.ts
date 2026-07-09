import type { Capture } from '../shared/operator'
import type { WatchpointRegistry } from './watchpoints'

/** Writes screenshots and watchpoint captures to disk. Fleshed out in Layers 2 & 4. */
export interface CaptureStore {
  ingest(
    environment: number,
    body: Record<string, unknown>,
    watchpoints: WatchpointRegistry
  ): Promise<Capture | null>
  get(environment: number, id: string): Capture | null
}
