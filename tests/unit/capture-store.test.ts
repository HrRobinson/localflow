import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CaptureStore } from '../../src/main/capture-store'
import { WatchpointRegistry } from '../../src/main/watchpoints'

describe('CaptureStore', () => {
  let base: string
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'lf-cap-'))
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('creates a per-environment scratch dir', () => {
    const store = new CaptureStore(base)
    const dir = store.dirFor(2)
    expect(dir).toBe(join(base, 'env-2'))
    expect(existsSync(dir)).toBe(true)
  })

  it('writes a screenshot and returns its absolute path', () => {
    const store = new CaptureStore(base)
    const png = Buffer.from('PNGDATA')
    const path = store.writeScreenshot(1, png)
    expect(path.startsWith(join(base, 'env-1'))).toBe(true)
    expect(path.endsWith('.png')).toBe(true)
    expect(readFileSync(path)).toEqual(png)
  })

  async function haltedCapture(
    store: CaptureStore,
    screenshotPath: string
  ): Promise<{ id: string }> {
    const wps = new WatchpointRegistry()
    const wp = wps.register(1, { workflow: 'w', step: 's', capture: ['screenshot'] })!
    const cap = await store.ingest(
      1,
      { watchpointId: wp.id, screenshotPath, halted: true, resumeToken: 'tok' },
      wps
    )
    expect(cap).not.toBeNull()
    return cap!
  }

  it('resolve deletes the screenshot file from the scratch dir', async () => {
    const store = new CaptureStore(base)
    const shot = store.writeScreenshot(1, Buffer.from('PNGDATA'))
    const cap = await haltedCapture(store, shot)
    expect(store.resolve(1, cap.id)).toBe('tok')
    expect(existsSync(shot)).toBe(false)
    expect(store.get(1, cap.id)?.screenshotPath).toBeUndefined()
  })

  it('resolve never deletes a screenshot path outside the scratch dir', async () => {
    const store = new CaptureStore(base)
    // screenshotPath arrives from the client, so a path outside the store's
    // own scratch dir must not become an arbitrary-delete primitive.
    const outside = join(mkdtempSync(join(tmpdir(), 'lf-out-')), 'keep.png')
    writeFileSync(outside, 'PNGDATA')
    try {
      const cap = await haltedCapture(store, outside)
      expect(store.resolve(1, cap.id)).toBe('tok')
      expect(existsSync(outside)).toBe(true)
      expect(store.get(1, cap.id)?.screenshotPath).toBe(outside)
    } finally {
      rmSync(join(outside, '..'), { recursive: true, force: true })
    }
  })

  it('reads a screenshot inside the store as a data uri, rejects paths outside', () => {
    const store = new CaptureStore(base)
    const path = store.writeScreenshot(1, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const uri = store.readScreenshotDataUri(path)
    expect(uri).not.toBeNull()
    expect(uri!.startsWith('data:image/png;base64,')).toBe(true)
    expect(store.readScreenshotDataUri('/etc/hosts')).toBeNull()
    expect(store.readScreenshotDataUri(join(base, 'missing.png'))).toBeNull()
  })

  it('clear removes the whole scratch dir', () => {
    const store = new CaptureStore(base)
    store.writeScreenshot(1, Buffer.from('A'))
    store.writeScreenshot(2, Buffer.from('B'))
    store.clear()
    expect(existsSync(base)).toBe(false)
  })
})
