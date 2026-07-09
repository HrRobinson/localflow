import { describe, it, expect } from 'vitest'
import { WebviewBrowserControl } from '../../src/main/browser-control'
import { BrowserBridge } from '../../src/main/browser-bridge'
import { CaptureStore } from '../../src/main/capture-store'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function make(): WebviewBrowserControl {
  const bridge = new BrowserBridge()
  const captures = new CaptureStore(mkdtempSync(join(tmpdir(), 'lf-bc-')))
  // No webContents registered — every op should degrade, never throw.
  return new WebviewBrowserControl(bridge, captures)
}

describe('WebviewBrowserControl', () => {
  it('navigate rejects a non-http url before touching the guest', async () => {
    const r = await make().navigate('h', 'javascript:alert(1)')
    expect(r).toEqual({ ok: false, error: expect.stringContaining('url') })
  })

  it('navigate on an unregistered handle errors (no webContents)', async () => {
    const r = await make().navigate('h', 'http://localhost:3000')
    expect(r.ok).toBe(false)
  })

  it('screenshot on an unregistered handle errors, never throws', async () => {
    const r = await make().screenshot('h', 1)
    expect(r.ok).toBe(false)
  })

  it('cookies/network on an unregistered handle return empty arrays', async () => {
    const bc = make()
    expect(await bc.cookies('h')).toEqual([])
    expect(await bc.network('h')).toEqual([])
  })
})
