import { describe, it, expect } from 'vitest'
import { guardHookCommand, type ResolvedGuard } from '../../src/main/guard-hook'

const base: ResolvedGuard = {
  bin: '/Application Support/localflow/lfguard',
  auditLog: '/Application Support/localflow/guard-audit.jsonl',
  packs: []
}

describe('guardHookCommand', () => {
  it('single-quotes the binary and audit path (spaces safe)', () => {
    const cmd = guardHookCommand(base, 'pane1')
    expect(cmd).toContain(`'/Application Support/localflow/lfguard' check --hook-exit`)
    expect(cmd).toContain(`--audit-log '/Application Support/localflow/guard-audit.jsonl'`)
    expect(cmd).toContain('--audit-tag pane1')
  })

  it('adds one --pack flag per enabled pack, skipping unsafe ids', () => {
    const cmd = guardHookCommand(
      { ...base, packs: ['cloud.gcloud', 'db.postgres', 'bad;id'] },
      'pane1'
    )
    expect(cmd).toContain('--pack cloud.gcloud')
    expect(cmd).toContain('--pack db.postgres')
    expect(cmd).not.toContain('bad;id')
  })

  it('rejects an unsafe paneId', () => {
    expect(() => guardHookCommand(base, 'pane 1; rm')).toThrow()
  })
})
