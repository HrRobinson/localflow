export type SessionStatus = 'idle' | 'working' | 'needs-you' | 'exited'

export type HookEventName = 'UserPromptSubmit' | 'Notification' | 'Stop'

export interface HookEvent {
  paneId: string
  event: HookEventName
}

export interface SessionInfo {
  id: string
  cwd: string
  status: SessionStatus
}
