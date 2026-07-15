import { describe, it, expect } from 'vitest'
import {
  toStatusEvent,
  toOperatorEvent,
  toCaptureEvent,
  toGuardEvent
} from '../../src/shared/console'
import type { ActivityEntry } from '../../src/shared/types'
import type { ActivityEntry as OperatorActivityEntry, Capture } from '../../src/shared/operator'

describe('console mappers', () => {
  it('maps a status entry to a status console event input', () => {
    const entry: ActivityEntry = { timestamp: 1, kind: 'Stop', status: 'idle' }
    const e = toStatusEvent('sess-1', 3, entry)
    expect(e.source).toBe('status')
    expect(e.environment).toBe(3)
    expect(e.sessionId).toBe('sess-1')
    expect(e.label.toLowerCase()).toContain('idle')
    expect(e.detail).toEqual({ source: 'status', kind: 'Stop', status: 'idle' })
  })

  it('maps an operator entry, carrying handle as sessionId and detail as args', () => {
    const entry: OperatorActivityEntry = {
      at: 1,
      route: 'operator:resume',
      handle: 'sess-9',
      detail: 'cap approve'
    }
    const e = toOperatorEvent(2, entry)
    expect(e.source).toBe('operator')
    expect(e.environment).toBe(2)
    expect(e.sessionId).toBe('sess-9')
    expect(e.detail).toEqual({ source: 'operator', action: 'operator:resume', args: 'cap approve' })
  })

  it('maps a capture to a capture console event with references only', () => {
    const cap: Capture = {
      id: 'cap-1',
      environment: 4,
      watchpointId: 'wp-1',
      createdAt: 1,
      halted: true,
      screenshotPath: '/x/shot.png',
      output: ['line']
    }
    const e = toCaptureEvent(cap)
    expect(e.source).toBe('capture')
    expect(e.environment).toBe(4)
    expect(e.sessionId).toBeUndefined()
    expect(e.detail).toEqual({
      source: 'capture',
      watchpointId: 'wp-1',
      captureId: 'cap-1',
      halted: true,
      screenshotPath: '/x/shot.png',
      output: ['line']
    })
  })

  it('maps a guard audit record to a guard console event', () => {
    const e = toGuardEvent(
      {
        ts: 1,
        tag: 'pane1',
        command: 'rm -rf /',
        reason: 'catastrophic rm',
        pack: 'core.filesystem'
      },
      3
    )
    expect(e.source).toBe('guard')
    expect(e.environment).toBe(3)
    expect(e.sessionId).toBe('pane1')
    expect(e.label).toContain('rm -rf /')
    expect(e.detail).toEqual({
      source: 'guard',
      command: 'rm -rf /',
      reason: 'catastrophic rm',
      pack: 'core.filesystem'
    })
  })
})
