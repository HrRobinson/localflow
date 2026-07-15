import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
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

  /**
   * Serve a capture screenshot as a data URI for inline preview. The path
   * arrives from the renderer, so only files inside this store's own dir are
   * ever read (same guard pruneScreenshot uses); anything else → null.
   */
  readScreenshotDataUri(path: string): string | null {
    const rel = relative(resolve(this.baseDir), resolve(path))
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
    try {
      return `data:image/png;base64,${readFileSync(path).toString('base64')}`
    } catch {
      return null
    }
  }

  async ingest(
    environment: number,
    body: Record<string, unknown>,
    watchpoints: WatchpointRegistry
  ): Promise<Capture | null> {
    const watchpointId = body['watchpointId']
    if (typeof watchpointId !== 'string') return null
    const wp = watchpoints.get(watchpointId)
    // Scope: the watch must exist AND belong to the ingesting environment.
    if (!wp || wp.environment !== environment) return null
    const capture: Capture = {
      id: randomUUID(),
      environment,
      watchpointId,
      createdAt: Date.now(),
      envelope: body['envelope'],
      output: Array.isArray(body['output']) ? (body['output'] as string[]) : undefined,
      memoryRef: typeof body['memoryRef'] === 'string' ? (body['memoryRef'] as string) : undefined,
      screenshotPath:
        typeof body['screenshotPath'] === 'string' ? (body['screenshotPath'] as string) : undefined,
      halted: body['halted'] === true,
      resumeToken:
        typeof body['resumeToken'] === 'string' ? (body['resumeToken'] as string) : undefined
    }
    this.store(capture)
    watchpoints.markHit(watchpointId)
    return capture
  }

  get(environment: number, id: string): Capture | null {
    return this.byEnv.get(environment)?.get(id) ?? null
  }

  list(environment: number): Capture[] {
    return [...this.byEnvList(environment)]
  }

  /** Clear the halted flag once the user resolves a halted capture; returns the resume token. */
  resolve(environment: number, id: string): string | null {
    const cap = this.byEnv.get(environment)?.get(id)
    if (!cap) return null
    cap.halted = false
    this.pruneScreenshot(cap)
    return cap.resumeToken ?? null
  }

  /** Remove the whole scratch dir (every env subdir); called on app quit. */
  clear(): void {
    rmSync(this.baseDir, { recursive: true, force: true })
  }

  /**
   * Delete a resolved capture's screenshot — the scratch file has served its
   * purpose once the user has acted on the capture. screenshotPath arrives
   * from the client (ingest body), so only paths inside this store's own
   * scratch dir are ever deleted; anything else is left untouched.
   */
  private pruneScreenshot(cap: Capture): void {
    const path = cap.screenshotPath
    if (!path) return
    const rel = relative(resolve(this.baseDir), resolve(path))
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return
    rmSync(path, { force: true })
    cap.screenshotPath = undefined
  }

  private byEnvList(environment: number): Capture[] {
    return [...(this.byEnv.get(environment)?.values() ?? [])].sort(
      (a, b) => a.createdAt - b.createdAt
    )
  }

  private store(capture: Capture): void {
    const map = this.byEnv.get(capture.environment) ?? new Map<string, Capture>()
    map.set(capture.id, capture)
    this.byEnv.set(capture.environment, map)
  }
}
