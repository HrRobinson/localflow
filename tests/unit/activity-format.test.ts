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

  it('pins the >1 boundary: count 2 gets a suffix, count 0 does not', () => {
    expect(activityLine('Notification', 2)).toBe('waiting for your approval ×2')
    // main never emits count 0 (absent = 1), but the formatter stays honest anyway
    expect(activityLine('Notification', 0)).toBe('waiting for your approval')
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
  it('pins the exact unit cutoffs', () => {
    // just-now floor: 4999ms floors to 4s (< 5), 5000ms is the first "s ago"
    expect(relativeTime(0, 4_999)).toBe('just now')
    expect(relativeTime(0, 5_000)).toBe('5s ago')
    // seconds → minutes at exactly 60s
    expect(relativeTime(0, 59_000)).toBe('59s ago')
    expect(relativeTime(0, 60_000)).toBe('1m ago')
    // minutes → hours at exactly 60m
    expect(relativeTime(0, 59 * 60_000)).toBe('59m ago')
    expect(relativeTime(0, 60 * 60_000)).toBe('1h ago')
    // hours → days at exactly 24h (23h59m still floors to 23h)
    expect(relativeTime(0, 23 * 3_600_000 + 59 * 60_000)).toBe('23h ago')
    expect(relativeTime(0, 24 * 3_600_000)).toBe('1d ago')
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
  it('pins the exact unit cutoffs', () => {
    // no just-now floor here: 4999ms floors to 4s, 5000ms to 5s
    expect(humanDuration(4_999)).toBe('4s')
    expect(humanDuration(5_000)).toBe('5s')
    // seconds → minutes at exactly 60s
    expect(humanDuration(59_000)).toBe('59s')
    expect(humanDuration(60_000)).toBe('1m')
    // minutes → hours at exactly 60m
    expect(humanDuration(59 * 60_000)).toBe('59m')
    expect(humanDuration(60 * 60_000)).toBe('1h')
    // hours → days at exactly 24h (23h59m still floors to 23h)
    expect(humanDuration(23 * 3_600_000 + 59 * 60_000)).toBe('23h')
    expect(humanDuration(24 * 3_600_000)).toBe('1d')
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
