import { describe, it, expect } from 'vitest'
import { BrowserBridge } from '../../src/main/browser-bridge'

describe('BrowserBridge', () => {
  it('maps a handle to a webContents id and back', () => {
    const bridge = new BrowserBridge()
    bridge.register('pane-1', 42)
    expect(bridge.webContentsIdFor('pane-1')).toBe(42)
    expect(bridge.webContentsIdFor('missing')).toBeNull()
  })

  it('unregister drops the mapping', () => {
    const bridge = new BrowserBridge()
    bridge.register('pane-1', 42)
    bridge.unregister('pane-1')
    expect(bridge.webContentsIdFor('pane-1')).toBeNull()
  })

  it('a re-register (remount) overwrites the stale id', () => {
    const bridge = new BrowserBridge()
    bridge.register('pane-1', 42)
    bridge.register('pane-1', 99)
    expect(bridge.webContentsIdFor('pane-1')).toBe(99)
  })
})
