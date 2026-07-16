import { describe, it, expect } from 'vitest'
import { resolveShellPath, type ShellRunner } from '../../src/main/resolve-shell-path'

const HOME = '/Users/tester'
const COMMON = [
  '/Users/tester/.local/bin',
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin'
]

/** A runner that echoes a fixed PATH wrapped in the sentinels the module emits. */
function fakeRunner(pathValue: string): ShellRunner {
  return async (_shell, args) => {
    // The probe command is the last arg: `printf '%s%s%s' 'START' "$PATH" 'END'`.
    // Extract the two sentinels and reproduce what a real shell would print.
    const cmd = args[args.length - 1]
    const m = cmd.match(/'([^']+)' "\$PATH" '([^']+)'/)
    const start = m ? m[1] : ''
    const end = m ? m[2] : ''
    return `${start}${pathValue}${end}`
  }
}

function entries(path: string): string[] {
  return path.split(':').filter((p) => p.length > 0)
}

describe('resolveShellPath', () => {
  it('unions the shell PATH with the process PATH without duplicates', async () => {
    const proc = '/usr/bin:/bin'
    const shell = '/Users/tester/.local/bin:/opt/homebrew/bin:/usr/bin'
    const result = await resolveShellPath({
      currentPath: proc,
      platform: 'darwin',
      home: HOME,
      runner: fakeRunner(shell)
    })
    const parts = entries(result)
    // No duplicates.
    expect(new Set(parts).size).toBe(parts.length)
    // Every process entry present.
    for (const p of entries(proc)) expect(parts).toContain(p)
    // Every shell entry present.
    for (const p of entries(shell)) expect(parts).toContain(p)
    // Original entries come first, preserving their priority.
    expect(parts[0]).toBe('/usr/bin')
    expect(parts[1]).toBe('/bin')
  })

  it('fails open to the original PATH when the runner throws synchronously', async () => {
    const proc = '/usr/bin:/bin'
    const result = await resolveShellPath({
      currentPath: proc,
      platform: 'darwin',
      home: HOME,
      runner: () => {
        throw new Error('shell blew up')
      }
    })
    // Original entries all survive; nothing is lost on failure.
    for (const p of entries(proc)) expect(entries(result)).toContain(p)
  })

  it('fails open to the original PATH when the runner rejects', async () => {
    const proc = '/usr/bin:/bin'
    const result = await resolveShellPath({
      currentPath: proc,
      platform: 'darwin',
      home: HOME,
      runner: () => Promise.reject(new Error('shell blew up'))
    })
    for (const p of entries(proc)) expect(entries(result)).toContain(p)
  })

  it('fails open (still usable) on timeout or empty output', async () => {
    const proc = '/usr/bin:/bin'
    const result = await resolveShellPath({
      currentPath: proc,
      platform: 'darwin',
      home: HOME,
      runner: async () => '' // simulates a wedged / silent shell
    })
    for (const p of entries(proc)) expect(entries(result)).toContain(p)
  })

  it('always includes the common-dir fallbacks even when the probe fails', async () => {
    const result = await resolveShellPath({
      currentPath: '/usr/bin:/bin',
      platform: 'darwin',
      home: HOME,
      runner: () => {
        throw new Error('nope')
      }
    })
    for (const dir of COMMON) expect(entries(result)).toContain(dir)
  })

  it('is an idempotent no-op-safe union when shell PATH equals process PATH', async () => {
    const same = `/usr/bin:/bin:${COMMON.join(':')}`
    const result = await resolveShellPath({
      currentPath: same,
      platform: 'darwin',
      home: HOME,
      runner: fakeRunner(same)
    })
    const parts = entries(result)
    // No duplicates were introduced.
    expect(new Set(parts).size).toBe(parts.length)
    // Identical input yields the same set, same order.
    expect(parts).toEqual(entries(same))
  })

  it('leaves the PATH unchanged on non-darwin platforms', async () => {
    const proc = '/usr/bin:/bin'
    let ran = false
    const result = await resolveShellPath({
      currentPath: proc,
      platform: 'linux',
      home: HOME,
      runner: async () => {
        ran = true
        return '/whatever'
      }
    })
    expect(result).toBe(proc)
    expect(ran).toBe(false)
  })

  it('fails open within a bounded time when the runner never resolves (pathological hang)', async () => {
    // Regression test for the execFileSync/spawnSync pipe-inheritance gotcha:
    // an rc file that backgrounds a grandchild holding the stdout pipe open
    // must never be able to extend resolveShellPath's wall-clock bound. Here
    // the injected runner itself never settles — standing in for a
    // defaultRunner whose process-group kill somehow failed to unblock the
    // pipe — and resolveShellPath must still resolve fail-open on its own,
    // bounded by timeoutMs, without waiting on the runner at all.
    const proc = '/usr/bin:/bin'
    const start = Date.now()
    const result = await resolveShellPath({
      currentPath: proc,
      platform: 'darwin',
      home: HOME,
      timeoutMs: 30,
      runner: () => new Promise<string>(() => {}) // never settles
    })
    const elapsed = Date.now() - start
    // Bounded well within the timeout's ballpark, not "eventually" or "never".
    expect(elapsed).toBeLessThan(500)
    for (const p of entries(proc)) expect(entries(result)).toContain(p)
  })

  it('fails open when the probe output has only a start sentinel (partial/malformed)', async () => {
    const proc = '/usr/bin:/bin'
    const result = await resolveShellPath({
      currentPath: proc,
      platform: 'darwin',
      home: HOME,
      runner: async () => '__LOCALFLOW_PATH_START__/some/leaked/partial/path'
      // no end sentinel — e.g. the shell was killed mid-write
    })
    const parts = entries(result)
    for (const p of entries(proc)) expect(parts).toContain(p)
    for (const dir of COMMON) expect(parts).toContain(dir)
    // The unterminated partial output must not leak into the resolved PATH.
    expect(parts).not.toContain('/some/leaked/partial/path')
    expect(result).not.toContain('__LOCALFLOW_PATH_START__')
  })
})
