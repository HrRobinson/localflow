import { handleRequest, type ControlDeps } from '../control-api'
import type { OperatorGrantStore } from '../operator-grant'
import type { AgentId } from '../../shared/types'

/**
 * The in-process control-API client for flow-driven panes. The engine is an
 * operator client exactly like the Linear connector and OpenClaw: it does NOT
 * reach into `SessionManager` privately to spawn/drive panes. It obtains the
 * environment's operator grant and calls the SAME `handleRequest` router
 * (documented pure over its inputs, so no socket is needed), so the capability
 * boundary (`OPERATOR_TERMINAL_AGENTS`), the lfguard prompt guard, and
 * per-environment isolation all apply to flow work identically (design §2.1).
 *
 * A rejected drive carries the router's OWN status + error body (a single
 * contract) rather than a re-worded one — the guard-block 403 message, the 409
 * "pane exited", the 400 "unknown group" all reach the node runner verbatim.
 */
export interface PaneDriverDeps {
  controlDeps: ControlDeps
  grants: OperatorGrantStore
}

export type DriveResult<T> = ({ ok: true } & T) | { ok: false; error: string }

const errorText = (status: number, json: unknown): string => {
  const body = json as { error?: unknown }
  const reason = typeof body?.error === 'string' ? body.error : 'unknown error'
  return `${status} ${reason}`
}

export class PaneDriver {
  constructor(private deps: PaneDriverDeps) {}

  /** POST /panes (terminal). The cwd is derived server-side from the group's
   *  members — never caller-supplied — so `groupId` must name a group in
   *  `environment` that already has a member with a usable cwd. */
  async createTerminal(
    environment: number,
    agentId: AgentId,
    groupId: string
  ): Promise<DriveResult<{ handle: string }>> {
    const token = this.deps.grants.grant(environment)
    const body = JSON.stringify({ kind: 'terminal', agentId, groupId })
    const res = await handleRequest(this.deps.controlDeps, 'POST', '/panes', token, body)
    if (res.status !== 200) return { ok: false, error: errorText(res.status, res.json) }
    const handle = (res.json as { pane?: { handle?: unknown } }).pane?.handle
    if (typeof handle !== 'string') {
      return { ok: false, error: `${res.status} malformed pane response` }
    }
    return { ok: true, handle }
  }

  /** POST /panes/:handle/prompt. The write is guarded by lfguard exactly like
   *  any operator prompt; a guard block returns 403 with the canonical deny
   *  message, which the caller surfaces verbatim. */
  async prompt(environment: number, handle: string, text: string): Promise<DriveResult<object>> {
    const token = this.deps.grants.grant(environment)
    const body = JSON.stringify({ text })
    const res = await handleRequest(
      this.deps.controlDeps,
      'POST',
      `/panes/${handle}/prompt`,
      token,
      body
    )
    if (res.status !== 200) return { ok: false, error: errorText(res.status, res.json) }
    return { ok: true }
  }
}
