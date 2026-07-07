import { describe, it, expect } from 'vitest'
import { pickNeighbor, swapInOrder, type PaneRect } from '../../src/renderer/src/lib/pane-nav'

// 2x2 grid: four 100x100 rects with a 10px gap, per the task brief.
const grid: PaneRect[] = [
  { id: 'a', x: 0, y: 0, w: 100, h: 100 },
  { id: 'b', x: 110, y: 0, w: 100, h: 100 },
  { id: 'c', x: 0, y: 110, w: 100, h: 100 },
  { id: 'd', x: 110, y: 110, w: 100, h: 100 }
]

describe('pickNeighbor', () => {
  it('finds the right neighbor from the top-left pane', () => {
    expect(pickNeighbor(grid, 'a', 'right')).toBe('b')
  })
  it('finds the down neighbor from the top-left pane', () => {
    expect(pickNeighbor(grid, 'a', 'down')).toBe('c')
  })
  it('has no left neighbor from the top-left pane', () => {
    expect(pickNeighbor(grid, 'a', 'left')).toBeNull()
  })
  it('has no up neighbor from the top-left pane', () => {
    expect(pickNeighbor(grid, 'a', 'up')).toBeNull()
  })

  it('finds the left neighbor from the top-right pane', () => {
    expect(pickNeighbor(grid, 'b', 'left')).toBe('a')
  })
  it('finds the down neighbor from the top-right pane', () => {
    expect(pickNeighbor(grid, 'b', 'down')).toBe('d')
  })
  it('has no right neighbor from the top-right pane', () => {
    expect(pickNeighbor(grid, 'b', 'right')).toBeNull()
  })
  it('has no up neighbor from the top-right pane', () => {
    expect(pickNeighbor(grid, 'b', 'up')).toBeNull()
  })

  it('finds the up neighbor from the bottom-left pane', () => {
    expect(pickNeighbor(grid, 'c', 'up')).toBe('a')
  })
  it('finds the right neighbor from the bottom-left pane', () => {
    expect(pickNeighbor(grid, 'c', 'right')).toBe('d')
  })
  it('has no left neighbor from the bottom-left pane', () => {
    expect(pickNeighbor(grid, 'c', 'left')).toBeNull()
  })
  it('has no down neighbor from the bottom-left pane', () => {
    expect(pickNeighbor(grid, 'c', 'down')).toBeNull()
  })

  it('finds the up neighbor from the bottom-right pane', () => {
    expect(pickNeighbor(grid, 'd', 'up')).toBe('b')
  })
  it('finds the left neighbor from the bottom-right pane', () => {
    expect(pickNeighbor(grid, 'd', 'left')).toBe('c')
  })
  it('has no right neighbor from the bottom-right pane', () => {
    expect(pickNeighbor(grid, 'd', 'right')).toBeNull()
  })
  it('has no down neighbor from the bottom-right pane', () => {
    expect(pickNeighbor(grid, 'd', 'down')).toBeNull()
  })

  it('returns null when the active id is unknown', () => {
    expect(pickNeighbor(grid, 'missing', 'right')).toBeNull()
  })

  it('breaks ties toward the orthogonally-aligned candidate', () => {
    // A third column pane directly to the right at the same row beats one
    // that is nominally closer in raw distance but offset vertically.
    const withOffsetColumn: PaneRect[] = [
      { id: 'a', x: 0, y: 0, w: 100, h: 100 },
      { id: 'b', x: 110, y: 0, w: 100, h: 100 }, // aligned, dx=110 dy=0
      { id: 'e', x: 150, y: 40, w: 100, h: 100 } // offset vertically, closer raw dx
    ]
    // e's center is (200, 90), a's center is (50, 50): dx=150, dy=40.
    // b's center is (160, 50): dx=110, dy=0.
    // score(b) = 110 + 2*0 = 110; score(e) = 150 + 2*40 = 230 -> b wins.
    expect(pickNeighbor(withOffsetColumn, 'a', 'right')).toBe('b')
  })
})

describe('swapInOrder', () => {
  it('swaps two adjacent ids', () => {
    expect(swapInOrder(['a', 'b', 'c'], 'a', 'b')).toEqual(['b', 'a', 'c'])
  })
  it('swaps two non-adjacent ids', () => {
    expect(swapInOrder(['a', 'b', 'c', 'd'], 'a', 'd')).toEqual(['d', 'b', 'c', 'a'])
  })
  it('leaves order unchanged when a is unknown', () => {
    expect(swapInOrder(['a', 'b', 'c'], 'x', 'b')).toEqual(['a', 'b', 'c'])
  })
  it('leaves order unchanged when b is unknown', () => {
    expect(swapInOrder(['a', 'b', 'c'], 'a', 'x')).toEqual(['a', 'b', 'c'])
  })
  it('returns a new array, not the same reference', () => {
    const original = ['a', 'b', 'c']
    const result = swapInOrder(original, 'a', 'b')
    expect(result).not.toBe(original)
    expect(original).toEqual(['a', 'b', 'c'])
  })
})
