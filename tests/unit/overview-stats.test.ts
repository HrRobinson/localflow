import { describe, it, expect } from 'vitest'
import { deriveOverviewStats } from '../../src/renderer/src/lib/overview-stats'
import type { SessionInfo } from '../../src/shared/types'

const s = (id: string, status: SessionInfo['status'], needsYouSince?: number): SessionInfo => ({
  id,
  cwd: '/tmp',
  name: id,
  status,
  agentId: 'claude',
  command: 'claude',
  environment: 1,
  kind: 'terminal',
  ...(needsYouSince === undefined ? {} : { needsYouSince })
})

describe('deriveOverviewStats', () => {
  it('counts by status in the canonical order, dropping empty buckets', () => {
    const stats = deriveOverviewStats(
      [
        s('a', 'working'),
        s('b', 'working'),
        s('c', 'needs-you', 1000),
        s('d', 'idle'),
        s('e', 'idle'),
        s('f', 'idle'),
        s('g', 'exited')
      ],
      2000
    )
    expect(stats.segments.map((seg) => `${seg.count} ${seg.label}`)).toEqual([
      '2 working',
      '1 needs you',
      '3 done',
      '1 off'
    ])
  })

  it('surfaces running as its own bucket between needs-you and done', () => {
    const stats = deriveOverviewStats([s('a', 'running'), s('b', 'idle')], 0)
    expect(stats.segments.map((seg) => `${seg.count} ${seg.label}`)).toEqual([
      '1 running',
      '1 done'
    ])
  })

  it('reports the oldest wait from the smallest needsYouSince', () => {
    const stats = deriveOverviewStats(
      [s('a', 'needs-you', 800_000), s('b', 'needs-you', 200_000)],
      920_000
    )
    // Oldest waiter started at 200_000 → 720_000 ms = 12m.
    expect(stats.oldestWaitMs).toBe(720_000)
  })

  it('has a null oldest wait when nobody is waiting', () => {
    expect(deriveOverviewStats([s('a', 'working'), s('b', 'idle')], 0).oldestWaitMs).toBeNull()
  })

  it('ignores a needs-you session with no stamp for the oldest-wait math', () => {
    const stats = deriveOverviewStats([s('a', 'needs-you')], 5000)
    expect(stats.segments[0]).toEqual({ status: 'needs-you', label: 'needs you', count: 1 })
    expect(stats.oldestWaitMs).toBeNull()
  })

  it('is empty for no sessions', () => {
    expect(deriveOverviewStats([], 0)).toEqual({ segments: [], oldestWaitMs: null })
  })
})
