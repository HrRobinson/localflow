import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AirtableCursorStore } from '../../src/main/airtable/airtable-cursor-store'

let dir: string
const file = (): string => join(dir, 'cursors.json')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lf-at-cur-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('AirtableCursorStore', () => {
  it('round-trips a cursor and rehydrates across a restart (spec §4.3)', () => {
    const s1 = new AirtableCursorStore({ file: file() })
    s1.set('achWEBHOOK', { kind: 'payloads', webhookId: 'achWEBHOOK', cursor: 42 })
    const s2 = new AirtableCursorStore({ file: file() })
    expect(s2.get('achWEBHOOK')).toEqual({ kind: 'payloads', webhookId: 'achWEBHOOK', cursor: 42 })
  })

  it('a missing/garbage sidecar → empty, never throws', () => {
    expect(new AirtableCursorStore({ file: file() }).get('x')).toBeUndefined()
    writeFileSync(file(), 'not json {{{')
    expect(new AirtableCursorStore({ file: file() }).get('x')).toBeUndefined()
  })

  it('clears a cursor on teardown', () => {
    const s = new AirtableCursorStore({ file: file() })
    s.set('a', { kind: 'payloads', webhookId: 'a', cursor: 1 })
    s.clear('a')
    expect(s.get('a')).toBeUndefined()
    expect(new AirtableCursorStore({ file: file() }).get('a')).toBeUndefined()
  })

  it('the sidecar holds ONLY the cursor — no record, no secret (spec §4.3)', () => {
    const s = new AirtableCursorStore({ file: file() })
    s.set('achW', { kind: 'payloads', webhookId: 'achW', cursor: 9 })
    const raw = readFileSync(file(), 'utf8')
    expect(raw).toContain('achW')
    expect(raw).toContain('9')
    expect(raw).not.toMatch(/pat|Bearer|fields|record|macSecret/i)
  })
})
