import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Capture } from '../shared/operator'
import type { WatchpointRegistry } from './watchpoints'

/**
 * Writes screenshots and watchpoint captures to disk under a per-environment
 * scratch dir the target project's terminal can read. A screenshot is handed to
 * a coding-agent terminal by PATH, never by pixels (spec "Screenshot → terminal
 * handoff"): screenshot() returns the path, the operator's prompt references it.
 * Captures are kept in-memory (not persisted across restarts) with their assets
 * on disk.
 */
export class CaptureStore {
  private byEnv = new Map<number, Map<string, Capture>>()

  constructor(private baseDir: string) {}

  /** Ensure + return `env-<N>/` under the base scratch dir. */
  dirFor(environment: number): string {
    const dir = join(this.baseDir, `env-${environment}`)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  /** Write a PNG capture; return its absolute path. */
  writeScreenshot(environment: number, png: Buffer): string {
    const path = join(this.dirFor(environment), `shot-${randomUUID()}.png`)
    writeFileSync(path, png)
    return path
  }

  /** Layer 4 fills in envelope/output/memory handling; see Task 15. */
  async ingest(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _environment: number,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _body: Record<string, unknown>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _watchpoints: WatchpointRegistry
  ): Promise<Capture | null> {
    return null
  }

  get(environment: number, id: string): Capture | null {
    return this.byEnv.get(environment)?.get(id) ?? null
  }

  /** Internal helper Layer 4 uses to file a completed capture. */
  protected store(capture: Capture): void {
    const map = this.byEnv.get(capture.environment) ?? new Map<string, Capture>()
    map.set(capture.id, capture)
    this.byEnv.set(capture.environment, map)
  }
}
