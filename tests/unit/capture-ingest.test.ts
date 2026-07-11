import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CaptureStore } from '../../src/main/capture-store'
import { WatchpointRegistry } from '../../src/main/watchpoints'

function store(): CaptureStore {
  return new CaptureStore(mkdtempSync(join(tmpdir(), 'lf-ing-')))
}

describe('CaptureStore.ingest', () => {
  it('stores a capture, marks the watch hit, and is retrievable', async () => {
    const wps = new WatchpointRegistry()
    const wp = wps.register(1, { workflow: 'w', step: 'verify', capture: ['envelope', 'output'] })!
    const cs = store()
    const cap = await cs.ingest(
      1,
      {
        watchpointId: wp.id,
        envelope: { status: 'ok' },
        output: ['done'],
        halted: true,
        resumeToken: 'tok-123'
      },
      wps
    )
    expect(cap).not.toBeNull()
    expect(cap!.halted).toBe(true)
    expect(wps.get(wp.id)!.hit).toBe(true)
    expect(cs.get(1, cap!.id)?.output).toEqual(['done'])
    expect(cs.list(1).map((c) => c.id)).toEqual([cap!.id])
  })

  it('rejects a capture for an unknown or foreign-env watchpoint', async () => {
    const wps = new WatchpointRegistry()
    const wp = wps.register(2, { workflow: 'w', step: 's', capture: ['envelope'] })!
    const cs = store()
    expect(await cs.ingest(1, { watchpointId: 'nope' }, wps)).toBeNull()
    // Watch belongs to env 2, ingest scoped to env 1 → rejected.
    expect(await cs.ingest(1, { watchpointId: wp.id }, wps)).toBeNull()
  })
})
