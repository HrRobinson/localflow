import { describe, it, expect, vi } from 'vitest'
import { selectApprovalPort } from '../../src/main/discord/approval-surface-select'
import type { ApprovalPort } from '../../src/main/flow/types'

const slack: ApprovalPort = { requestApproval: async () => true }
const discord: ApprovalPort = { requestApproval: async () => false }

describe('selectApprovalPort (§4.3, §13.2)', () => {
  it('picks Discord when only Discord is connected', () => {
    expect(selectApprovalPort({ discord })).toBe(discord)
  })

  it('picks Slack when only Slack is connected', () => {
    expect(selectApprovalPort({ slack })).toBe(slack)
  })

  it('honors an explicit config.approvalSurface when that surface is available', () => {
    expect(selectApprovalPort({ slack, discord, approvalSurface: 'discord' })).toBe(discord)
    expect(selectApprovalPort({ slack, discord, approvalSurface: 'slack' })).toBe(slack)
  })

  it('when BOTH connected with no choice: deterministic Slack + a LOUD notice (never silent)', () => {
    const onAmbiguous = vi.fn()
    expect(selectApprovalPort({ slack, discord, onAmbiguous })).toBe(slack)
    expect(onAmbiguous).toHaveBeenCalledWith('slack')
  })

  it('falls back through when the configured surface is not actually available', () => {
    // approvalSurface says discord, but only slack is connected → slack.
    expect(selectApprovalPort({ slack, approvalSurface: 'discord' })).toBe(slack)
  })

  it('returns null when neither is available (caller uses the safe-reject stub)', () => {
    expect(selectApprovalPort({})).toBeNull()
  })
})
