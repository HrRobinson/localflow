import type { ActivityEntry, ActivityEventKind, SessionStatus } from './types'
import type { ActivityEntry as OperatorActivityEntry, Capture } from './operator'
import type { ConsoleScope } from './console-filter'

// 'guard' = lfguard deny (audit-log tail); 'network' = browser-pane CDP (Console v2).
export type ConsoleSource = 'status' | 'operator' | 'capture' | 'guard' | 'network'

/** Per-source ring caps shared by the main-process bus and the renderer's
 *  live buffer, so the two can never silently drift out of sync. */
export const CONSOLE_SOURCE_CAPS: Record<ConsoleSource, number> = {
  status: 500,
  operator: 500,
  capture: 300,
  guard: 300,
  network: 2000
}

export interface NetworkDetailInput {
  requestId: string
  method: string
  url: string
  status?: number
  type?: string
  durationMs?: number
  sizeBytes?: number
  fromCache?: boolean
  failed?: boolean
  errorText?: string
  incomplete?: boolean
}

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
  | ({ source: 'network' } & NetworkDetailInput)
  | { source: 'guard'; command: string; reason: string; pack: string }

export interface ConsoleEvent {
  id: string
  seq: number
  ts: number
  source: ConsoleSource
  environment: number
  sessionId?: string
  label: string
  detail: ConsoleDetail
}

/** What a mapper returns; the bus assigns id + seq + ts (main-process authority). */
export type ConsoleEventInput = Omit<ConsoleEvent, 'id' | 'ts' | 'seq'>

/** Persisted drawer prefs (height, open state, last filter). */
export interface ConsolePrefs {
  height: number
  open: boolean
  sources: ConsoleSource[]
  text: string
  scope: 'auto' | ConsoleScope
  muted: ConsoleSource[]
}

export const DEFAULT_CONSOLE_PREFS: ConsolePrefs = {
  height: 240,
  open: false,
  sources: [],
  text: '',
  scope: 'auto',
  muted: []
}

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

function truncateUrl(url: string, max = 96): string {
  return url.length > max ? `${url.slice(0, max)}…` : url
}

export function toNetworkEvent(
  environment: number,
  detail: NetworkDetailInput,
  sessionId?: string
): ConsoleEventInput {
  const statusText = detail.status ?? (detail.incomplete ? '⏳' : 'ERR')
  return {
    source: 'network',
    environment,
    sessionId,
    label: `${detail.method} ${statusText} · ${truncateUrl(detail.url)}`,
    detail: { source: 'network', ...detail }
  }
}

export interface GuardAuditRecord {
  ts: number
  tag: string | null
  command: string
  reason: string
  pack: string
}

export function toGuardEvent(record: GuardAuditRecord, environment: number): ConsoleEventInput {
  return {
    source: 'guard',
    environment,
    sessionId: record.tag ?? undefined,
    label: `blocked: ${record.command}`,
    detail: { source: 'guard', command: record.command, reason: record.reason, pack: record.pack }
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

/**
 * The one-off userData carry-over that follows the product rename. It runs
 * before the bus exists, so main buffers the summary string and replays it
 * here once the bus is constructed. Emitted on `operator` deliberately: adding
 * a sixth ConsoleSource would change CONSOLE_SOURCE_CAPS, the renderer filter
 * chips and the persisted ConsolePrefs shape, which is out of scope.
 */
export function toMigrationEvent(summary: string, environment = 1): ConsoleEventInput {
  return {
    source: 'operator',
    environment,
    label: `userData migration · ${summary}`,
    detail: { source: 'operator', action: 'userdata-migration', args: summary }
  }
}
