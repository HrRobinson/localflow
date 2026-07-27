import { describe, it, expect } from 'vitest'
import { ApiGrantBinding } from '../../src/main/api-client/grant-binding'

describe('ApiGrantBinding', () => {
  it('binds an environment to a pane and its collection set', () => {
    const b = new ApiGrantBinding()
    b.bind(1, 'pane-a', ['stripe'])
    expect(b.get(1)).toEqual({ paneId: 'pane-a', collectionIds: ['stripe'] })
  })

  it('resolves the environment a pane holds the grant for', () => {
    const b = new ApiGrantBinding()
    b.bind(3, 'pane-a', ['stripe'])
    expect(b.environmentForPane('pane-a')).toBe(3)
    expect(b.environmentForPane('pane-b')).toBeNull()
  })

  it('unbinds', () => {
    const b = new ApiGrantBinding()
    b.bind(1, 'pane-a', ['stripe'])
    b.unbind(1)
    expect(b.get(1)).toBeUndefined()
    expect(b.environmentForPane('pane-a')).toBeNull()
  })

  it('moving the grant to a second pane releases the first', () => {
    // ApiGrantStore mints one token per environment, so a second grant MOVES it.
    const b = new ApiGrantBinding()
    b.bind(1, 'pane-a', ['stripe'])
    b.bind(1, 'pane-b', ['stripe', 'internal'])
    expect(b.environmentForPane('pane-a')).toBeNull()
    expect(b.environmentForPane('pane-b')).toBe(1)
    expect(b.get(1)?.collectionIds).toEqual(['stripe', 'internal'])
  })

  it('keeps environments independent', () => {
    const b = new ApiGrantBinding()
    b.bind(1, 'pane-a', ['stripe'])
    b.bind(2, 'pane-b', ['other'])
    b.unbind(1)
    expect(b.environmentForPane('pane-b')).toBe(2)
    expect(b.get(2)?.collectionIds).toEqual(['other'])
  })

  it('copies the collection set so a caller cannot mutate it afterwards', () => {
    const b = new ApiGrantBinding()
    const ids = ['stripe']
    b.bind(1, 'pane-a', ids)
    ids.push('smuggled')
    expect(b.get(1)?.collectionIds).toEqual(['stripe'])
  })

  it('does not leak the internal array through get', () => {
    const b = new ApiGrantBinding()
    b.bind(1, 'pane-a', ['stripe'])
    b.get(1)?.collectionIds.push('smuggled')
    expect(b.get(1)?.collectionIds).toEqual(['stripe'])
  })

  it('lists the environments that currently hold a grant', () => {
    const b = new ApiGrantBinding()
    expect(b.environments()).toEqual([])
    b.bind(1, 'pane-a', ['stripe'])
    b.bind(4, 'pane-b', ['other'])
    expect(b.environments().sort((x, y) => x - y)).toEqual([1, 4])
    b.unbind(1)
    expect(b.environments()).toEqual([4])
  })
})
