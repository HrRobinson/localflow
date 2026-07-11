import { describe, it, expect, afterEach } from 'vitest'
import { WebviewBrowserControl } from '../../src/main/browser-control'
import { BrowserBridge } from '../../src/main/browser-bridge'
import { CaptureStore } from '../../src/main/capture-store'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempDirs: string[] = []

function make(): WebviewBrowserControl {
  const bridge = new BrowserBridge()
  const dir = mkdtempSync(join(tmpdir(), 'lf-bc-'))
  tempDirs.push(dir)
  const captures = new CaptureStore(dir)
  // No webContents registered — every op should degrade, never throw.
  return new WebviewBrowserControl(bridge, captures)
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

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

describe('act validation', () => {
  it('rejects a missing selector', async () => {
    const bc = make()
    const r = await bc.act('h', { action: 'click' })
    expect(r).toEqual({ ok: false, error: expect.stringContaining('selector') })
  })

  it('rejects an unknown action', async () => {
    const bc = make()
    const r = await bc.act('h', { selector: '#go', action: 'teleport' })
    expect(r).toEqual({ ok: false, error: expect.stringContaining('action') })
  })

  it('errors on an unregistered handle for a valid body', async () => {
    const bc = make()
    const r = await bc.act('h', { selector: '#go', action: 'click' })
    expect(r.ok).toBe(false)
  })
})
