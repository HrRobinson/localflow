import { describe, it, expect } from 'vitest'
import { parseAuditLines } from '../../src/main/guard-audit-tail'

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
