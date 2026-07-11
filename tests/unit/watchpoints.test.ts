import { describe, it, expect } from 'vitest'
import { WatchpointRegistry } from '../../src/main/watchpoints'

describe('WatchpointRegistry', () => {
  it('registers a valid watch and lists it by environment', () => {
    const reg = new WatchpointRegistry()
    const wp = reg.register(1, {
      workflow: 'style-fix',
      step: 'verify',
      capture: ['screenshot', 'output']
    })
    expect(wp).not.toBeNull()
    expect(wp!.hit).toBe(false)
    expect(reg.list(1).map((w) => w.id)).toEqual([wp!.id])
    expect(reg.list(2)).toEqual([])
  })

  it('rejects a malformed watch', () => {
    const reg = new WatchpointRegistry()
    expect(reg.register(1, { step: 'verify', capture: [] })).toBeNull()
    expect(reg.register(1, { workflow: 'w', capture: [] })).toBeNull()
    expect(reg.register(1, { workflow: 'w', step: 's', capture: ['bogus'] })).toBeNull()
  })

  it('markHit flips the flag', () => {
    const reg = new WatchpointRegistry()
    const wp = reg.register(1, { workflow: 'w', step: 's', capture: ['envelope'] })!
    reg.markHit(wp.id)
    expect(reg.get(wp.id)!.hit).toBe(true)
  })
})
