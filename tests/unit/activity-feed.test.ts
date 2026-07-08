import { describe, it, expect } from 'vitest'
import { upsertActivity } from '../../src/renderer/src/lib/activity-feed'
import type { ActivityEntry } from '../../src/shared/types'

const entry = (over: Partial<ActivityEntry> = {}): ActivityEntry => ({
  timestamp: 1000,
  kind: 'Notification',
  status: 'needs-you',
  ...over
})

describe('upsertActivity', () => {
  it('replaces the last row for a repeated hook kind with the same status', () => {
    const prev = [entry({ timestamp: 1000 })]
    const next = upsertActivity(prev, entry({ timestamp: 2000, count: 2 }))
    expect(next).toEqual([entry({ timestamp: 2000, count: 2 })])
  })

  it('propagates the updated count into the replacing row', () => {
    const prev = [entry({ count: 2 })]
    const next = upsertActivity(prev, entry({ timestamp: 3000, count: 3 }))
    expect(next).toHaveLength(1)
    expect(next[0].count).toBe(3)
    expect(next[0].timestamp).toBe(3000)
  })

  it('appends a repeated lifecycle kind even with the same status', () => {
    const moved = entry({ kind: 'moved', status: 'idle' })
    const next = upsertActivity([moved], entry({ kind: 'moved', status: 'idle', timestamp: 2000 }))
    expect(next).toHaveLength(2)
    expect(next[0]).toEqual(moved)
    expect(next[1].timestamp).toBe(2000)
  })

  it('appends when the kind differs', () => {
    const prev = [entry({ kind: 'UserPromptSubmit', status: 'working' })]
    const next = upsertActivity(prev, entry({ kind: 'Stop', status: 'working' }))
    expect(next).toHaveLength(2)
  })

  it('appends when the status differs', () => {
    const prev = [entry({ kind: 'Notification', status: 'working' })]
    const next = upsertActivity(prev, entry({ kind: 'Notification', status: 'needs-you' }))
    expect(next).toHaveLength(2)
  })

  it('appends to an empty list', () => {
    const next = upsertActivity([], entry())
    expect(next).toEqual([entry()])
  })

  it('does not mutate the input array', () => {
    const prev = [entry()]
    upsertActivity(prev, entry({ count: 2 }))
    expect(prev).toEqual([entry()])
  })
})
