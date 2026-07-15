import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { parseAuditLines, startGuardAuditTail } from '../../src/main/guard-audit-tail'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    watch: vi.fn(() => {
      const fake = new EventEmitter() as unknown as ReturnType<typeof actual.watch>
      // FSWatcher exposes close(); the tail's stop() calls watcher?.close().
      Object.assign(fake, { close: () => {} })
      return fake
    })
  }
})

describe('parseAuditLines', () => {
  it('parses valid JSONL deny records, skips blanks and junk', () => {
    const text = [
      JSON.stringify({
        ts: 1,
        tag: 'p1',
        command: 'rm -rf /',
        reason: 'r',
        pack: 'core.filesystem'
      }),
      '',
      'not json',
      JSON.stringify({
        ts: 2,
        tag: null,
        command: 'git push --force',
        reason: 'r2',
        pack: 'core.git'
      })
    ].join('\n')
    const recs = parseAuditLines(text)
    expect(recs.map((r) => r.command)).toEqual(['rm -rf /', 'git push --force'])
    expect(recs[1].tag).toBeNull()
  })

  it('drops records missing required fields', () => {
    const text = JSON.stringify({ ts: 1, command: 'x' }) // no reason/pack
    expect(parseAuditLines(text)).toEqual([])
  })
})

describe('startGuardAuditTail', () => {
  it('survives the watcher emitting an error (fail-open, never crash)', async () => {
    const { watch } = await import('node:fs')
    const stop = startGuardAuditTail({
      path: '/nonexistent/guard-audit-tail-test.log',
      onRecords: () => {}
    })
    const fakeWatcher = vi.mocked(watch).mock.results[0]?.value as EventEmitter
    expect(fakeWatcher).toBeInstanceOf(EventEmitter)
    expect(() => fakeWatcher.emit('error', new Error('ENOENT: simulated'))).not.toThrow()
    stop()
  })
})
