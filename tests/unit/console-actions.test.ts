import { describe, it, expect } from 'vitest'
import { rowActions } from '../../src/shared/console-actions'
import type { ConsoleEvent } from '../../src/shared/console'

function row(source: ConsoleEvent['source'], detail: ConsoleEvent['detail']): ConsoleEvent {
  return { id: 'x', ts: 1, source, environment: 1, label: 'l', detail }
}

describe('rowActions', () => {
  it('offers rerun-watchpoint + open-source on capture rows', () => {
    const e = row('capture', {
      source: 'capture',
      watchpointId: 'w',
      captureId: 'c',
      halted: false
    })
    expect(rowActions(e).sort()).toEqual(['open-source', 'rerun-watchpoint'])
  })

  it('offers only open-source on status and operator rows', () => {
    expect(rowActions(row('status', { source: 'status', kind: 'Stop', status: 'idle' }))).toEqual([
      'open-source'
    ])
    expect(rowActions(row('operator', { source: 'operator', action: 'x' }))).toEqual([
      'open-source'
    ])
  })
})
