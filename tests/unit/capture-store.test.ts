import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CaptureStore } from '../../src/main/capture-store'

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
})
