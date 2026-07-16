import { describe, it, expect } from 'vitest'
import { mapStatusToActivity, HEARTBEAT_INTERVAL_MS } from '../../src/main/linear/status-map'
import type { ActivityEntry } from '../../src/shared/types'

const now = 1_000_000

describe('mapStatusToActivity', () => {
  describe('working → thought / action', () => {
    it('emits an ack thought on the first working tick (pending → active)', () => {
      const r = mapStatusToActivity({ status: 'working' }, { now })
      expect(r).toEqual({
        activity: { kind: 'thought', body: expect.stringMatching(/working/i) },
        state: 'active'
      })
    })

    it('emits a resuming thought when returning from awaitingInput', () => {
      const r = mapStatusToActivity(
        { status: 'working' },
        { now, lastEmittedState: 'awaitingInput' }
      )
      expect(r?.activity.kind).toBe('thought')
      expect(r?.activity.body).toMatch(/resum/i)
      expect(r?.state).toBe('active')
    })

    it('debounces heartbeats: no emit within the interval while already active', () => {
      const r = mapStatusToActivity(
        { status: 'working' },
        { now, lastEmittedState: 'active', lastActivityAt: now - (HEARTBEAT_INTERVAL_MS - 1) }
      )
      expect(r).toBeNull()
    })

    it('emits a heartbeat thought once the interval has elapsed', () => {
      const r = mapStatusToActivity(
        { status: 'working' },
        { now, lastEmittedState: 'active', lastActivityAt: now - HEARTBEAT_INTERVAL_MS }
      )
      expect(r?.activity.kind).toBe('thought')
      expect(r?.state).toBe('active')
    })

    it('emits an action (not a thought) for an activity entry while working', () => {
      const entry: ActivityEntry = { timestamp: now, kind: 'moved', status: 'working' }
      const r = mapStatusToActivity(
        { status: 'working', entry },
        { now, lastEmittedState: 'active', lastActivityAt: now }
      )
      expect(r?.activity.kind).toBe('action')
      expect(r?.state).toBe('active')
    })

    it('actions are not debounced (emit even within the heartbeat interval)', () => {
      const entry: ActivityEntry = { timestamp: now, kind: 'moved', status: 'working' }
      const r = mapStatusToActivity(
        { status: 'working', entry },
        { now, lastEmittedState: 'active', lastActivityAt: now }
      )
      expect(r?.activity.kind).toBe('action')
    })
  })

  describe('needs-you → elicitation (transition-only)', () => {
    it('emits an elicitation carrying the pending question', () => {
      const r = mapStatusToActivity(
        { status: 'needs-you', peekText: 'Proceed with the migration?' },
        { now, lastEmittedState: 'active' }
      )
      expect(r).toEqual({
        activity: { kind: 'elicitation', body: 'Proceed with the migration?' },
        state: 'awaitingInput'
      })
    })

    it('falls back to a legible default when no pending question is available', () => {
      const r = mapStatusToActivity({ status: 'needs-you' }, { now, lastEmittedState: 'active' })
      expect(r?.activity.kind).toBe('elicitation')
      expect(r?.activity.body.length).toBeGreaterThan(0)
    })

    it('does not re-emit while already awaitingInput', () => {
      const r = mapStatusToActivity(
        { status: 'needs-you', peekText: 'still?' },
        { now, lastEmittedState: 'awaitingInput' }
      )
      expect(r).toBeNull()
    })
  })

  describe('idle → response (transition-only)', () => {
    it('emits a response on turn completion', () => {
      const r = mapStatusToActivity({ status: 'idle' }, { now, lastEmittedState: 'active' })
      expect(r?.activity.kind).toBe('response')
      expect(r?.state).toBe('complete')
    })

    it('does not re-emit once already complete', () => {
      const r = mapStatusToActivity({ status: 'idle' }, { now, lastEmittedState: 'complete' })
      expect(r).toBeNull()
    })
  })

  describe('exited → error (transition-only, carries the real tail)', () => {
    it('emits an error whose body is the instant-exit tail', () => {
      const r = mapStatusToActivity(
        { status: 'exited', message: "Could not start 'claude' — check the agent's path" },
        { now, lastEmittedState: 'active' }
      )
      expect(r?.activity.kind).toBe('error')
      expect(r?.activity.body).toContain("Could not start 'claude'")
      expect(r?.state).toBe('error')
    })

    it('does not emit for a clean exit with no failure message', () => {
      const r = mapStatusToActivity({ status: 'exited' }, { now, lastEmittedState: 'active' })
      expect(r).toBeNull()
    })

    it('does not re-emit once already error', () => {
      const r = mapStatusToActivity(
        { status: 'exited', message: 'boom' },
        { now, lastEmittedState: 'error' }
      )
      expect(r).toBeNull()
    })
  })

  describe('states with no Linear mapping', () => {
    it('returns null for running (browser panes)', () => {
      expect(mapStatusToActivity({ status: 'running' }, { now })).toBeNull()
    })

    it('ignores stray activity entries outside working', () => {
      const entry: ActivityEntry = { timestamp: now, kind: 'moved', status: 'idle' }
      expect(
        mapStatusToActivity({ status: 'idle', entry }, { now, lastEmittedState: 'complete' })
      ).toBeNull()
    })
  })
})
