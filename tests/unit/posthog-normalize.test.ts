import { describe, it, expect } from 'vitest'
import {
  cohortMembers,
  normalizeCohort,
  normalizeEvent,
  normalizeFeatureFlag,
  normalizeInsight
} from '../../src/main/posthog/posthog-normalize'

/**
 * The CORRECTNESS BOUNDARY the conditions track depends on (spec §6.3): a raw
 * PostHog payload → the pinned context shape, with numbers as numbers, booleans
 * as booleans, timestamps as ISO strings. Pure functions, exhaustively tested
 * with no live project (spec §12).
 */

describe('normalizeEvent', () => {
  it('maps a raw event to the pinned event.* shape (uuid→id, distinct_id→distinctId)', () => {
    const raw = {
      uuid: 'evt-1',
      event: '$feature_flag_error',
      distinct_id: 'person-7',
      timestamp: '2026-07-18T10:00:00.000Z',
      properties: { $flag: 'new-checkout', code: 500 }
    }
    expect(normalizeEvent(raw)).toEqual({
      event: {
        id: 'evt-1',
        name: '$feature_flag_error',
        distinctId: 'person-7',
        timestamp: '2026-07-18T10:00:00.000Z',
        properties: { $flag: 'new-checkout', code: 500 }
      }
    })
  })

  it('is defensive against absent/garbage fields (never throws)', () => {
    expect(normalizeEvent(null).event).toEqual({
      id: '',
      name: '',
      distinctId: '',
      timestamp: '',
      properties: {}
    })
    expect(normalizeEvent({ properties: 'nope' }).event.properties).toEqual({})
  })
})

describe('normalizeInsight', () => {
  it('pulls the aggregated value from result[0].aggregated_value as a NUMBER', () => {
    const raw = {
      id: 42,
      name: 'checkout error rate',
      result: [{ aggregated_value: 2.5 }],
      last_refresh: '2026-07-18T10:00:00.000Z',
      unit: '%'
    }
    expect(normalizeInsight(raw)).toEqual({
      insight: {
        id: '42',
        name: 'checkout error rate',
        value: 2.5,
        unit: '%',
        computedAt: '2026-07-18T10:00:00.000Z'
      }
    })
  })

  it('falls back to result[0].count then a top-level value', () => {
    expect(normalizeInsight({ result: [{ count: 7 }] }).insight.value).toBe(7)
    expect(normalizeInsight({ value: '13' }).insight.value).toBe(13)
    expect(normalizeInsight({}).insight.value).toBe(0)
  })
})

describe('normalizeCohort', () => {
  it('reports count (explicit) and carries an entered distinct id when given', () => {
    const raw = { id: 9, name: 'churn-risk', count: 128 }
    expect(normalizeCohort(raw, 'person-new')).toEqual({
      cohort: { id: '9', name: 'churn-risk', count: 128, enteredDistinctId: 'person-new' }
    })
  })

  it('derives count from the member list when no explicit count', () => {
    const raw = { id: 9, name: 'churn-risk', members: ['a', 'b', 'c'] }
    expect(normalizeCohort(raw).cohort.count).toBe(3)
    expect(normalizeCohort(raw).cohort.enteredDistinctId).toBeUndefined()
  })
})

describe('cohortMembers', () => {
  it('reads distinct ids from a list of strings or person objects', () => {
    expect(cohortMembers({ members: ['a', 'b'] })).toEqual(['a', 'b'])
    expect(cohortMembers({ persons: [{ distinct_id: 'x' }, { id: 'y' }] })).toEqual(['x', 'y'])
    expect(cohortMembers({})).toEqual([])
  })
})

describe('normalizeFeatureFlag', () => {
  it('maps active→boolean and a top-level rollout %', () => {
    const raw = { id: 3, key: 'new-checkout', active: true, rollout_percentage: 25 }
    expect(normalizeFeatureFlag(raw)).toEqual({
      flag: { id: '3', key: 'new-checkout', active: true, rolloutPercentage: 25 }
    })
  })

  it('reads a single-group filters rollout, else null', () => {
    const grouped = {
      id: 3,
      key: 'k',
      active: false,
      filters: { groups: [{ rollout_percentage: 10 }] }
    }
    expect(normalizeFeatureFlag(grouped).flag).toEqual({
      id: '3',
      key: 'k',
      active: false,
      rolloutPercentage: 10
    })
    // Multi-group ⇒ no single top-level number ⇒ null.
    const multi = { id: 3, key: 'k', active: true, filters: { groups: [{}, {}] } }
    expect(normalizeFeatureFlag(multi).flag.rolloutPercentage).toBeNull()
  })
})
