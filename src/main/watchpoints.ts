import { randomUUID } from 'node:crypto'
import { CAPTURE_KINDS, type CaptureKind, type Watchpoint } from '../shared/operator'

/**
 * In-memory registry of workflow watchpoints. The user writes a watch against a
 * workflow + step label + what to capture; when the OpenClaw-side `checkpoint`
 * action fires (POST /captures), the capture ingest marks the matching watch hit.
 * Not persisted across restarts (spec "Out of scope").
 */
export class WatchpointRegistry {
  private byId = new Map<string, Watchpoint>()

  register(environment: number, body: Record<string, unknown>): Watchpoint | null {
    const workflow = body['workflow']
    const step = body['step']
    const capture = body['capture']
    if (typeof workflow !== 'string' || workflow.length === 0) return null
    if (typeof step !== 'string' || step.length === 0) return null
    if (!Array.isArray(capture) || capture.length === 0) return null
    if (!capture.every((k) => (CAPTURE_KINDS as readonly string[]).includes(k as string)))
      return null
    const paneHandle =
      typeof body['paneHandle'] === 'string' ? (body['paneHandle'] as string) : undefined
    const wp: Watchpoint = {
      id: randomUUID(),
      environment,
      workflow,
      step,
      capture: capture as CaptureKind[],
      paneHandle,
      hit: false
    }
    this.byId.set(wp.id, wp)
    return wp
  }

  list(environment: number): Watchpoint[] {
    return [...this.byId.values()].filter((w) => w.environment === environment)
  }

  get(id: string): Watchpoint | null {
    return this.byId.get(id) ?? null
  }

  markHit(id: string): void {
    const wp = this.byId.get(id)
    if (wp) wp.hit = true
  }
}
