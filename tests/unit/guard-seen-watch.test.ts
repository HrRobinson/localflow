import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startGuardSeenWatch } from '../../src/main/guard-seen-watch'

describe('startGuardSeenWatch (real fs.watch)', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const scratch = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'lf-seen-watch-'))
    dirs.push(d)
    return d
  }

  it('fires onSeen(tag) when a marker file named <tag> is written', async () => {
    const dir = scratch()
    const seen: string[] = []
    const stop = startGuardSeenWatch({ dir, onSeen: (tag) => seen.push(tag) })
    writeFileSync(join(dir, 'pane-abc'), String(Date.now()))
    await vi.waitFor(() => expect(seen).toContain('pane-abc'), { timeout: 3000 })
    stop()
  })

  it('fires again when the same marker is overwritten', async () => {
    const dir = scratch()
    const seen: string[] = []
    const stop = startGuardSeenWatch({ dir, onSeen: (tag) => seen.push(tag) })
    writeFileSync(join(dir, 'pane-1'), '1')
    await vi.waitFor(() => expect(seen.filter((t) => t === 'pane-1').length).toBeGreaterThan(0), {
      timeout: 3000
    })
    writeFileSync(join(dir, 'pane-1'), '2')
    await vi.waitFor(() => expect(seen.filter((t) => t === 'pane-1').length).toBeGreaterThan(1), {
      timeout: 3000
    })
    stop()
  })

  it('never throws on a missing dir and stop() is safe', () => {
    const missing = join(tmpdir(), `lf-seen-missing-${Date.now()}`)
    let stop: () => void = () => {}
    expect(() => {
      stop = startGuardSeenWatch({ dir: missing, onSeen: () => {} })
    }).not.toThrow()
    expect(() => stop()).not.toThrow()
    rmSync(missing, { recursive: true, force: true })
  })
})

describe('startGuardSeenWatch (mocked fs)', () => {
  it('stop() clears the interval and closes the watcher; swallows watcher errors', async () => {
    vi.resetModules()
    const closed = { count: 0 }
    const fakeWatcher = new EventEmitter() as unknown as EventEmitter & { close: () => void }
    fakeWatcher.close = () => {
      closed.count++
    }
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>()
      return { ...actual, watch: vi.fn(() => fakeWatcher), mkdirSync: vi.fn() }
    })
    const { startGuardSeenWatch: start } = await import('../../src/main/guard-seen-watch')
    const stop = start({ dir: '/whatever', onSeen: () => {} })
    // An FSWatcher 'error' must not throw (fail-open, never crash main).
    expect(() => fakeWatcher.emit('error', new Error('simulated'))).not.toThrow()
    stop()
    expect(closed.count).toBe(1)
    vi.doUnmock('node:fs')
    vi.resetModules()
  })
})

describe('startGuardSeenWatch (self-heals dropped fs.watch events)', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.doUnmock('node:fs')
    vi.resetModules()
  })

  it('sweeps the dir on each poll tick and reports a marker the watch callback missed', async () => {
    vi.resetModules()
    vi.useFakeTimers()
    const fakeWatcher = new EventEmitter() as unknown as EventEmitter & { close: () => void }
    fakeWatcher.close = () => {}
    let entries: string[] = []
    const readdirSync = vi.fn(() => entries)
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>()
      // watch() never invokes its callback here, simulating an fs.watch event
      // the OS silently dropped/coalesced.
      return { ...actual, watch: vi.fn(() => fakeWatcher), mkdirSync: vi.fn(), readdirSync }
    })
    const { startGuardSeenWatch: start } = await import('../../src/main/guard-seen-watch')
    const seen: string[] = []
    const stop = start({ dir: '/whatever', onSeen: (tag) => seen.push(tag) })

    // Marker lands on disk, but the fs.watch callback is never fired.
    entries = ['pane-dropped']
    await vi.advanceTimersByTimeAsync(1000)
    expect(seen).toEqual(['pane-dropped'])

    // Marker is still present on the next tick; already reported, so the
    // sweep must not invoke onSeen again for it.
    await vi.advanceTimersByTimeAsync(1000)
    expect(seen).toEqual(['pane-dropped'])

    stop()
  })

  it('a missing/unreadable dir during the sweep is fail-open (no throw)', async () => {
    vi.resetModules()
    vi.useFakeTimers()
    const fakeWatcher = new EventEmitter() as unknown as EventEmitter & { close: () => void }
    fakeWatcher.close = () => {}
    const readdirSync = vi.fn(() => {
      throw new Error('ENOENT: simulated')
    })
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>()
      return { ...actual, watch: vi.fn(() => fakeWatcher), mkdirSync: vi.fn(), readdirSync }
    })
    const { startGuardSeenWatch: start } = await import('../../src/main/guard-seen-watch')
    const seen: string[] = []
    const stop = start({ dir: '/whatever', onSeen: (tag) => seen.push(tag) })
    await expect(vi.advanceTimersByTimeAsync(1000)).resolves.not.toThrow()
    expect(seen).toEqual([])
    stop()
  })
})
