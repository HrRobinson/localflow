import { describe, it, expect } from 'vitest'
import {
  activityLine,
  relativeTime,
  humanDuration,
  currentStateLine
} from '../../src/renderer/src/lib/activity-format'
import type { SessionInfo } from '../../src/shared/types'

const base: SessionInfo = {
  id: 's',
  cwd: '/tmp',
  name: 's',
  status: 'idle',
  agentId: 'claude',
  command: 'claude',
  environment: 1,
  kind: 'terminal'
}

describe('activityLine', () => {
  it('maps every kind to plain language', () => {
    expect(activityLine('created')).toBe('session created')
    expect(activityLine('reopened')).toBe('session reopened')
    expect(activityLine('closed')).toBe('you closed the terminal')
    expect(activityLine('exited')).toBe('process exited')
    expect(activityLine('moved')).toBe('moved to another environment')
    expect(activityLine('UserPromptSubmit')).toBe('you sent a prompt')
    expect(activityLine('Notification')).toBe('waiting for your approval')
    expect(activityLine('Stop')).toBe('turn finished')
  })

  it('appends the collapse count when greater than 1', () => {
    expect(activityLine('Notification', 3)).toBe('waiting for your approval ×3')
  })

  it('renders no suffix when count is undefined or 1', () => {
    expect(activityLine('Notification', undefined)).toBe('waiting for your approval')
    expect(activityLine('Notification', 1)).toBe('waiting for your approval')
  })
})

describe('relativeTime', () => {
  it('says "just now" under 5 seconds, clamping negatives', () => {
    expect(relativeTime(1000, 1000)).toBe('just now')
    expect(relativeTime(0, 3000)).toBe('just now')
    expect(relativeTime(5000, 0)).toBe('just now')
  })
  it('scales through seconds, minutes, hours, days', () => {
    expect(relativeTime(0, 30_000)).toBe('30s ago')
    expect(relativeTime(0, 120_000)).toBe('2m ago')
    expect(relativeTime(0, 3 * 3_600_000)).toBe('3h ago')
    expect(relativeTime(0, 2 * 86_400_000)).toBe('2d ago')
  })
})

describe('humanDuration', () => {
  it('renders the largest whole unit, compactly', () => {
    expect(humanDuration(0)).toBe('0s')
    expect(humanDuration(45_000)).toBe('45s')
    expect(humanDuration(12 * 60_000)).toBe('12m')
    expect(humanDuration(3 * 3_600_000)).toBe('3h')
    expect(humanDuration(2 * 86_400_000)).toBe('2d')
  })
})

describe('currentStateLine', () => {
  it('shows how long a needs-you session has waited', () => {
    expect(currentStateLine({ ...base, status: 'needs-you', needsYouSince: 0 }, 12 * 60_000)).toBe(
      '⏳ waiting for your approval for 12m'
    )
  })
  it('falls back gracefully when needsYouSince is absent', () => {
    expect(currentStateLine({ ...base, status: 'needs-you' }, 0)).toBe(
      '⏳ waiting for your approval'
    )
  })
  it('has an honest line for the other states', () => {
    expect(currentStateLine({ ...base, status: 'working' }, 0)).toBe('● working')
    expect(currentStateLine({ ...base, status: 'idle' }, 0)).toBe('✓ idle — last turn finished')
    expect(currentStateLine({ ...base, status: 'running' }, 0)).toBe('● running')
    expect(currentStateLine({ ...base, status: 'exited' }, 0)).toBe('○ exited')
  })
})
