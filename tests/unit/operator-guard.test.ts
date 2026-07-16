import { describe, it, expect, vi } from 'vitest'
import { makeOperatorGuard, type GuardRunner } from '../../src/main/operator-guard'

// A runner that returns a canned result and records how it was called.
function fakeRunner(result: { code: number | null; stderr: string; timedOut: boolean }): {
  runner: GuardRunner
  calls: { bin: string; args: string[]; timeout: number }[]
} {
  const calls: { bin: string; args: string[]; timeout: number }[] = []
  const runner: GuardRunner = async (bin, args, opts) => {
    calls.push({ bin, args, timeout: opts.timeout })
    return result
  }
  return { runner, calls }
}

const base = {
  resolveBinary: () => '/bin/lfguard',
  getPacks: () => [] as string[]
}

describe('makeOperatorGuard', () => {
  it('denies on exit 1 and parses pack + reason from stderr', async () => {
    const { runner } = fakeRunner({
      code: 1,
      stderr: 'lfguard: BLOCKED by core.filesystem: catastrophic rm',
      timedOut: false
    })
    const g = makeOperatorGuard({ ...base, runner })
    expect(await g.check('rm -rf /')).toEqual({
      allowed: false,
      reason: 'catastrophic rm',
      pack: 'core.filesystem'
    })
  })

  it('finds the BLOCKED line even when pack warnings precede it', async () => {
    const { runner } = fakeRunner({
      code: 1,
      stderr:
        'lfguard: pack warning (core.git): noise\n' +
        'lfguard: BLOCKED by core.filesystem: catastrophic rm (inline: bash -c)',
      timedOut: false
    })
    const g = makeOperatorGuard({ ...base, runner })
    expect(await g.check('x')).toEqual({
      allowed: false,
      reason: 'catastrophic rm (inline: bash -c)',
      pack: 'core.filesystem'
    })
  })

  it('allows on exit 0', async () => {
    const { runner } = fakeRunner({ code: 0, stderr: '', timedOut: false })
    const g = makeOperatorGuard({ ...base, runner })
    expect(await g.check('ls')).toEqual({ allowed: true })
  })

  it('denies on exit 1 with unparseable stderr using a generic reason', async () => {
    const { runner } = fakeRunner({ code: 1, stderr: 'garbled output', timedOut: false })
    const g = makeOperatorGuard({ ...base, runner })
    expect(await g.check('x')).toEqual({
      allowed: false,
      reason: 'blocked by command guard',
      pack: 'unknown'
    })
  })

  it('fails open on a spawn error (code null)', async () => {
    const { runner } = fakeRunner({ code: null, stderr: '', timedOut: false })
    const g = makeOperatorGuard({ ...base, runner })
    expect(await g.check('x')).toEqual({ allowed: true })
  })

  it('fails open on timeout', async () => {
    const { runner } = fakeRunner({ code: null, stderr: '', timedOut: true })
    const g = makeOperatorGuard({ ...base, runner })
    expect(await g.check('x')).toEqual({ allowed: true })
  })

  it('fails open on any other exit code', async () => {
    const { runner } = fakeRunner({ code: 2, stderr: 'clap parse error', timedOut: false })
    const g = makeOperatorGuard({ ...base, runner })
    expect(await g.check('x')).toEqual({ allowed: true })
  })

  it('allows empty/whitespace commands without invoking the runner', async () => {
    let called = false
    const runner: GuardRunner = async () => {
      called = true
      return { code: 0, stderr: '', timedOut: false }
    }
    const g = makeOperatorGuard({ ...base, runner })
    expect(await g.check('   ')).toEqual({ allowed: true })
    expect(called).toBe(false)
  })

  it('allows without invoking the runner when the binary is absent', async () => {
    let called = false
    const runner: GuardRunner = async () => {
      called = true
      return { code: 0, stderr: '', timedOut: false }
    }
    const g = makeOperatorGuard({ resolveBinary: () => null, getPacks: () => [], runner })
    expect(await g.check('rm -rf /')).toEqual({ allowed: true })
    expect(called).toBe(false)
  })

  it('forwards packs as repeated --pack args and passes command as one argv element', async () => {
    const { runner, calls } = fakeRunner({ code: 0, stderr: '', timedOut: false })
    const g = makeOperatorGuard({
      resolveBinary: () => '/bin/lfguard',
      getPacks: () => ['cloud.gcloud', 'db.postgres'],
      runner
    })
    await g.check('gcloud auth print-access-token')
    expect(calls[0].bin).toBe('/bin/lfguard')
    expect(calls[0].args).toEqual([
      'test',
      'gcloud auth print-access-token',
      '--pack',
      'cloud.gcloud',
      '--pack',
      'db.postgres'
    ])
  })

  it('passes the configured timeout to the runner (default 2000)', async () => {
    const { runner, calls } = fakeRunner({ code: 0, stderr: '', timedOut: false })
    const g = makeOperatorGuard({ ...base, runner })
    await g.check('ls')
    expect(calls[0].timeout).toBe(2000)
  })

  it('forwards a non-default timeoutMs to the runner', async () => {
    const { runner, calls } = fakeRunner({ code: 0, stderr: '', timedOut: false })
    const g = makeOperatorGuard({ ...base, runner, timeoutMs: 500 })
    await g.check('ls')
    expect(calls[0].timeout).toBe(500)
  })

  it('fails open if the runner itself throws', async () => {
    const runner: GuardRunner = async () => {
      throw new Error('boom')
    }
    const g = makeOperatorGuard({ ...base, runner })
    expect(await g.check('x')).toEqual({ allowed: true })
  })

  it('logs the malfunction when the runner throws, but still fails open', async () => {
    const boom = new Error('boom')
    const runner: GuardRunner = async () => {
      throw boom
    }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const g = makeOperatorGuard({ ...base, runner })
      const verdict = await g.check('rm -rf /')
      // The invariant this proves: a guard malfunction is NEVER allowed to
      // flip a verdict to blocked — fail-open is absolute, unconditional.
      expect(verdict).toEqual({ allowed: true })
      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(errorSpy.mock.calls[0].join(' ')).toContain('failing open')
      expect(errorSpy.mock.calls[0]).toContain(boom)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('logs a warning for an unexpected exit code, still fails open', async () => {
    const { runner } = fakeRunner({ code: 2, stderr: 'clap parse error', timedOut: false })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const g = makeOperatorGuard({ ...base, runner })
      expect(await g.check('x')).toEqual({ allowed: true })
      expect(warnSpy).toHaveBeenCalledTimes(1)
      const msg = warnSpy.mock.calls[0].join(' ')
      expect(msg).toContain('exited 2')
      expect(msg).toContain('clap parse error')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('logs a warning when deny stderr does not match the expected format', async () => {
    const { runner } = fakeRunner({ code: 1, stderr: 'garbled output', timedOut: false })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const g = makeOperatorGuard({ ...base, runner })
      expect(await g.check('x')).toEqual({
        allowed: false,
        reason: 'blocked by command guard',
        pack: 'unknown'
      })
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy.mock.calls[0].join(' ')).toContain('garbled output')
    } finally {
      warnSpy.mockRestore()
    }
  })
})
