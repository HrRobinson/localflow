import { describe, it, expect } from 'vitest'
import {
  normalizeSegmentEvent,
  eventMatches,
  parseTriggerConfig,
  assertNamedTrack
} from '../../src/main/segment/segment-normalize'
import type { SegmentTriggerConfig } from '../../src/shared/segment'

describe('normalizeSegmentEvent (§6.5) — the correctness boundary', () => {
  it('maps a track body to the pinned context shape', () => {
    const ctx = normalizeSegmentEvent({
      type: 'track',
      event: 'Subscription Downgraded',
      userId: 'u_1',
      messageId: 'm_1',
      timestamp: '2026-07-20T00:00:00.000Z',
      properties: { mrr: 500, plan: 'pro' }
    })
    expect(ctx).toEqual({
      event: {
        type: 'track',
        name: 'Subscription Downgraded',
        userId: 'u_1',
        anonymousId: '',
        messageId: 'm_1',
        timestamp: '2026-07-20T00:00:00.000Z',
        properties: { mrr: 500, plan: 'pro' },
        traits: {}
      }
    })
  })

  it('maps an identify body — traits preserved, name empty, anonymousId coerced', () => {
    const ctx = normalizeSegmentEvent({
      type: 'identify',
      anonymousId: 'anon_9',
      messageId: 'm_2',
      traits: { plan: 'enterprise' }
    })
    expect(ctx.event.type).toBe('identify')
    expect(ctx.event.name).toBe('')
    expect(ctx.event.userId).toBe('')
    expect(ctx.event.anonymousId).toBe('anon_9')
    expect(ctx.event.traits).toEqual({ plan: 'enterprise' })
    expect(ctx.event.properties).toEqual({})
  })

  it('never throws on a sparse / garbage body — safe string defaults', () => {
    const ctx = normalizeSegmentEvent({ type: 'nonsense', userId: 42, properties: 'not-an-object' })
    // Unknown type falls back to 'track'; non-string ids coerce to ''.
    expect(ctx.event.type).toBe('track')
    expect(ctx.event.userId).toBe('')
    expect(ctx.event.properties).toEqual({})
    expect(ctx.event.name).toBe('')
  })
})

describe('eventMatches (§7.2) — the pre-seed hard filter', () => {
  const ctx = normalizeSegmentEvent({
    type: 'track',
    event: 'Subscription Downgraded',
    userId: 'u_1',
    messageId: 'm_1',
    properties: { plan: 'pro', mrr: 500 }
  })

  it('passes an exact type + name + match', () => {
    const cfg: SegmentTriggerConfig = {
      type: 'track',
      event: 'Subscription Downgraded',
      match: { plan: 'pro' }
    }
    expect(eventMatches(cfg, ctx)).toBe(true)
  })

  it('drops on a type mismatch', () => {
    expect(eventMatches({ type: 'identify' }, ctx)).toBe(false)
  })

  it('drops on a name mismatch', () => {
    expect(eventMatches({ type: 'track', event: 'Trial Started' }, ctx)).toBe(false)
  })

  it('drops on a match-value mismatch', () => {
    expect(
      eventMatches(
        { type: 'track', event: 'Subscription Downgraded', match: { plan: 'free' } },
        ctx
      )
    ).toBe(false)
  })

  it('defaults type to track and matches identify traits', () => {
    const idCtx = normalizeSegmentEvent({
      type: 'identify',
      userId: 'u_2',
      traits: { plan: 'enterprise' }
    })
    expect(eventMatches({ type: 'identify', match: { plan: 'enterprise' } }, idCtx)).toBe(true)
    expect(eventMatches({ type: 'identify', match: { plan: 'pro' } }, idCtx)).toBe(false)
  })
})

describe('assertNamedTrack (§7.3) — the structural firehose guard', () => {
  it('refuses a track config with no event name', () => {
    expect(() => assertNamedTrack({ type: 'track' })).toThrow(/must name an event/)
    // The default type is track, so an empty config is also the firehose.
    expect(() => assertNamedTrack({})).toThrow(/must name an event/)
  })

  it('accepts a named track and any identify config', () => {
    expect(() => assertNamedTrack({ type: 'track', event: 'X' })).not.toThrow()
    expect(() => assertNamedTrack({ type: 'identify' })).not.toThrow()
  })
})

describe('parseTriggerConfig — coerce the raw node config', () => {
  it('reads type/event/match and drops junk', () => {
    expect(
      parseTriggerConfig({ type: 'track', event: 'X', match: { a: 1, b: true, c: 'y', d: {} } })
    ).toEqual({ type: 'track', event: 'X', match: { a: 1, b: true, c: 'y' } })
  })

  it('ignores an unknown type (falls to undefined → default track downstream)', () => {
    expect(parseTriggerConfig({ type: 'bogus' })).toEqual({})
  })
})
