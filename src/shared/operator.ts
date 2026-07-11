/** Shared operator/control-API types. No I/O — used by main and renderer. */

export type PaneKind = 'browser' | 'terminal'

/** One pane as seen over the control API. `handle` is the session id. */
export interface PaneView {
  handle: string
  kind: PaneKind
  title: string
  cwd: string
  url?: string
  status: string
}

export type CaptureKind = 'envelope' | 'screenshot' | 'output' | 'memory'

export interface Watchpoint {
  id: string
  environment: number
  workflow: string
  step: string
  capture: CaptureKind[]
  paneHandle?: string
  /** Flipped true once a matching capture arrives. */
  hit: boolean
}

export interface Capture {
  id: string
  environment: number
  watchpointId: string
  createdAt: number
  envelope?: unknown
  screenshotPath?: string
  output?: string[]
  memoryRef?: string
  /** True when the workflow halted on Lobster's approve token for review. */
  halted: boolean
  resumeToken?: string
}

/** One recorded control-API call, for the cockpit's action log. */
export interface ActivityEntry {
  at: number
  route: string
  handle?: string
  detail?: string
}

/** Returned to the UI/skill on grant: where + how to reach the control API. */
export interface GrantInfo {
  environment: number
  endpoint: string
  token: string
}

export interface OperatorStatus {
  environment: number
  granted: boolean
  connected: boolean
  endpoint?: string
  activity: ActivityEntry[]
}

/** Request/response bodies over this size are rejected with 400. */
export const CONTROL_MAX_BODY_BYTES = 65536
