import type { ConsoleEventInput, NetworkDetailInput } from '../shared/console'
import { toNetworkEvent } from '../shared/console'

const REQUEST_TIMEOUT_MS = 30_000

interface Pending {
  requestId: string
  method: string
  url: string
  type?: string
  startedAt: number
  status?: number
  fromCache?: boolean
}

export interface NetworkTapDeps {
  environment: number
  sessionId?: string
  emitBatch: (inputs: ConsoleEventInput[]) => void
  now?: () => number
}

/**
 * Coalesces the browser pane's existing CDP Network stream per requestId into
 * one completed row, and guarantees nothing in-flight vanishes silently:
 * pending entries flush as `incomplete` rows at lifecycle boundaries
 * (destroy/navigation) and after a 30s per-request timeout. Bus-agnostic —
 * it only calls the injected emitBatch (P2.2).
 */
export class NetworkTap {
  private pending = new Map<string, Pending>()
  private queue: NetworkDetailInput[] = []
  private readonly now: () => number

  constructor(private deps: NetworkTapDeps) {
    this.now = deps.now ?? Date.now
  }

  onMessage(method: string, params: Record<string, unknown>): void {
    const requestId = params['requestId']
    if (typeof requestId !== 'string') return
    if (method === 'Network.requestWillBeSent') {
      const req = params['request'] as { url?: string; method?: string } | undefined
      this.pending.set(requestId, {
        requestId,
        method: req?.method ?? 'GET',
        url: req?.url ?? '',
        type: typeof params['type'] === 'string' ? (params['type'] as string) : undefined,
        startedAt: this.now()
      })
    } else if (method === 'Network.responseReceived') {
      const entry = this.pending.get(requestId)
      if (!entry) return
      const res = params['response'] as { status?: number; fromDiskCache?: boolean } | undefined
      entry.status = res?.status
      entry.fromCache = res?.fromDiskCache === true
    } else if (method === 'Network.loadingFinished') {
      const entry = this.pending.get(requestId)
      if (!entry) return
      this.pending.delete(requestId)
      const size = params['encodedDataLength']
      this.enqueue({
        requestId: entry.requestId,
        method: entry.method,
        url: entry.url,
        status: entry.status,
        type: entry.type,
        durationMs: this.now() - entry.startedAt,
        sizeBytes: typeof size === 'number' ? size : undefined,
        fromCache: entry.fromCache
      })
    } else if (method === 'Network.loadingFailed') {
      const entry = this.pending.get(requestId)
      if (!entry) return
      this.pending.delete(requestId)
      const errorText = params['errorText']
      this.enqueue({
        requestId: entry.requestId,
        method: entry.method,
        url: entry.url,
        status: entry.status,
        type: entry.type,
        durationMs: this.now() - entry.startedAt,
        failed: true,
        errorText: typeof errorText === 'string' ? errorText : undefined
      })
    }
  }

  /** Flush every still-pending request as an `incomplete` row (lifecycle boundary). */
  flushIncomplete(): void {
    for (const entry of this.pending.values()) {
      this.enqueue({
        requestId: entry.requestId,
        method: entry.method,
        url: entry.url,
        status: entry.status,
        type: entry.type,
        durationMs: this.now() - entry.startedAt,
        incomplete: true
      })
    }
    this.pending.clear()
    this.flush()
  }

  /** Drain the queue to the bus in one fan-out (Task 10 adds the 50-cap). */
  flush(): void {
    this.sweepTimeouts()
    if (this.queue.length === 0) return
    const batch = this.queue.splice(0, this.queue.length)
    this.deps.emitBatch(
      batch.map((d) => toNetworkEvent(this.deps.environment, d, this.deps.sessionId))
    )
  }

  private sweepTimeouts(): void {
    const cutoff = this.now() - REQUEST_TIMEOUT_MS
    for (const [id, entry] of this.pending) {
      if (entry.startedAt <= cutoff) {
        this.pending.delete(id)
        this.enqueue({
          requestId: entry.requestId,
          method: entry.method,
          url: entry.url,
          status: entry.status,
          type: entry.type,
          durationMs: this.now() - entry.startedAt,
          incomplete: true
        })
      }
    }
  }

  private enqueue(detail: NetworkDetailInput): void {
    this.queue.push(detail)
  }
}
