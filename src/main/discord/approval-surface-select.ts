import type { ApprovalPort } from '../flow/types'

/**
 * Port selection when Slack AND/OR Discord can each supply an `ApprovalPort`
 * (spec §4.3, §13.2). The engine takes EXACTLY ONE port; this picks it. NO
 * engine change — the selection happens at wiring time in `index.ts`.
 *
 * MVP rule: `config.approvalSurface` wins when set; otherwise whichever of
 * {Slack, Discord} is connected. When BOTH are connected with no
 * `approvalSurface` set, that is a flagged open decision (§13.2) — MVP resolves
 * it DETERMINISTICALLY (Slack wins as the first-shipped surface, with a loud
 * notice via `onAmbiguous`) rather than silently picking. Returns `null` when
 * neither is available (the caller then falls back to the safe-reject stub).
 */

export type ApprovalSurface = 'slack' | 'discord'

export interface SelectApprovalPortDeps {
  slack?: ApprovalPort
  discord?: ApprovalPort
  /** An explicit `config.approvalSurface`, when the user pinned one. */
  approvalSurface?: ApprovalSurface
  /** Called when both are connected with no explicit choice — a loud notice
   *  (never a silent pick). */
  onAmbiguous?: (chosen: ApprovalSurface) => void
}

export function selectApprovalPort(deps: SelectApprovalPortDeps): ApprovalPort | null {
  const { slack, discord, approvalSurface, onAmbiguous } = deps
  // 1. An explicit config choice wins — but only if that surface is available.
  if (approvalSurface === 'slack' && slack) return slack
  if (approvalSurface === 'discord' && discord) return discord
  // 2. Both connected, no explicit choice: deterministic (Slack first-shipped),
  //    with a loud notice (§13.2) — never a silent pick.
  if (slack && discord) {
    onAmbiguous?.('slack')
    return slack
  }
  // 3. Exactly one available → it is the port.
  if (slack) return slack
  if (discord) return discord
  // 4. Neither → the caller uses the safe-reject stub.
  return null
}
