import { describe, it, expect } from 'vitest'
import { CONSOLE_SOURCE_CAPS, toMigrationEvent } from '../../src/shared/console'

describe('toMigrationEvent', () => {
  it('maps a summary onto the operator source with a legible label', () => {
    const event = toMigrationEvent('copied 12 file(s) from /old')
    expect(event).toEqual({
      source: 'operator',
      environment: 1,
      label: 'userData migration · copied 12 file(s) from /old',
      detail: {
        source: 'operator',
        action: 'userdata-migration',
        args: 'copied 12 file(s) from /old'
      }
    })
  })

  it('accepts an explicit environment', () => {
    expect(toMigrationEvent('no migration needed (no-legacy-dir)', 4).environment).toBe(4)
  })

  it('does not introduce a new console source', () => {
    expect(Object.keys(CONSOLE_SOURCE_CAPS).sort()).toEqual([
      'capture',
      'guard',
      'network',
      'operator',
      'status'
    ])
  })
})
