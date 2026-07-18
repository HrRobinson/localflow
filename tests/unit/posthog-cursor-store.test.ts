import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PostHogCursorStore } from '../../src/main/posthog/posthog-cursor-store'

/**
 * The persisted, NON-SECRET cursor sidecar (spec §7.4): survives a restart, holds
 * only the cursor (no analytics payload, no secret), atomic writes, and tolerates
 * a missing/garbage file as the first-run case.
 */

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lf-ph-cursor-'))
  file = join(dir, 'cursors.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('PostHogCursorStore', () => {
  it('persists and reloads each cursor kind across a restart', () => {
    const store = new PostHogCursorStore({ file })
    store.set('event.matched:*:', { kind: 'event', ts: '2026-07-18T10:00:00Z', lastUuid: 'e9' })
    store.set('cohort.entered:9', { kind: 'cohort', members: ['a', 'b'] })
    store.set('insight.threshold:5:2:above', { kind: 'insight', lastValue: 3 })

    const reloaded = new PostHogCursorStore({ file })
    expect(reloaded.get('event.matched:*:')).toEqual({
      kind: 'event',
      ts: '2026-07-18T10:00:00Z',
      lastUuid: 'e9'
    })
    expect(reloaded.get('cohort.entered:9')).toEqual({ kind: 'cohort', members: ['a', 'b'] })
    expect(reloaded.get('insight.threshold:5:2:above')).toEqual({ kind: 'insight', lastValue: 3 })
  })

  it('clear removes a cursor', () => {
    const store = new PostHogCursorStore({ file })
    store.set('insight.threshold:5:2:above', { kind: 'insight', lastValue: 1 })
    store.clear('insight.threshold:5:2:above')
    expect(store.get('insight.threshold:5:2:above')).toBeUndefined()
  })

  it('a missing or garbage sidecar starts empty (first-run case), never throws', () => {
    expect(new PostHogCursorStore({ file }).get('x')).toBeUndefined()
    writeFileSync(file, 'not json {{{')
    expect(new PostHogCursorStore({ file }).get('x')).toBeUndefined()
  })

  it('the sidecar holds no secret material — only cursor scalars', () => {
    const store = new PostHogCursorStore({ file })
    store.set('event.matched:*:', { kind: 'event', ts: '2026-07-18T10:00:00Z', lastUuid: 'e9' })
    const onDisk = readFileSync(file, 'utf8')
    expect(onDisk).not.toMatch(/phx_|Bearer|Authorization|personalApiKey/)
  })
})
