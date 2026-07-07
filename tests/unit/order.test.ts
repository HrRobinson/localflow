import { describe, it, expect } from 'vitest'
import { reconcileOrder } from '../../src/renderer/src/lib/order'

describe('reconcileOrder', () => {
  it('appends new ids in session order', () => {
    expect(reconcileOrder(['a'], ['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
  })
  it('drops ids no longer present in sessions', () => {
    expect(reconcileOrder(['a', 'b', 'c'], ['a', 'c'])).toEqual(['a', 'c'])
  })
  it('is stable when nothing changed', () => {
    expect(reconcileOrder(['a', 'b'], ['a', 'b'])).toEqual(['a', 'b'])
  })
  it('handles simultaneous add and remove', () => {
    expect(reconcileOrder(['a', 'b'], ['b', 'c'])).toEqual(['b', 'c'])
  })
  it('handles empty order and empty ids', () => {
    expect(reconcileOrder([], [])).toEqual([])
    expect(reconcileOrder([], ['a'])).toEqual(['a'])
    expect(reconcileOrder(['a'], [])).toEqual([])
  })
})
