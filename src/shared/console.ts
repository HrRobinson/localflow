import type { ActivityEntry, ActivityEventKind, SessionStatus } from './types'
import type { ActivityEntry as OperatorActivityEntry, Capture } from './operator'

// 'network' is reserved for v2 (browser-pane CDP). Do NOT produce it in v1.
export type ConsoleSource = 'status' | 'operator' | 'capture' | 'network'

export type ConsoleDetail =
  | { source: 'status'; kind: ActivityEventKind; status: SessionStatus }
  | { source: 'operator'; action: string; args?: string }
  | {
      source: 'capture'
      watchpointId: string
      captureId: string
      halted: boolean
      screenshotPath?: string
      output?: string[]
    }

export interface ConsoleEvent {
  id: string
  ts: number
  source: ConsoleSource
  environment: number
  sessionId?: string
  label: string
  detail: ConsoleDetail
}

/** What a mapper returns; the bus assigns id + ts (main-process authority). */
export type ConsoleEventInput = Omit<ConsoleEvent, 'id' | 'ts'>

export function toStatusEvent(
  sessionId: string,
  environment: number,
  entry: ActivityEntry
): ConsoleEventInput {
  return {
    source: 'status',
    environment,
    sessionId,
    label: `${entry.kind} · ${entry.status}`,
    detail: { source: 'status', kind: entry.kind, status: entry.status }
  }
}

export function toOperatorEvent(
  environment: number,
  entry: OperatorActivityEntry
): ConsoleEventInput {
  return {
    source: 'operator',
    environment,
    sessionId: entry.handle,
    label: entry.detail ? `${entry.route} · ${entry.detail}` : entry.route,
    detail: { source: 'operator', action: entry.route, args: entry.detail }
  }
}

export function toCaptureEvent(capture: Capture): ConsoleEventInput {
  return {
    source: 'capture',
    environment: capture.environment,
    label: capture.halted
      ? `capture ${capture.watchpointId} · halted`
      : `capture ${capture.watchpointId}`,
    detail: {
      source: 'capture',
      watchpointId: capture.watchpointId,
      captureId: capture.id,
      halted: capture.halted,
      screenshotPath: capture.screenshotPath,
      output: capture.output
    }
  }
}
