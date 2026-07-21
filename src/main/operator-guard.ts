import { execFile } from 'node:child_process'

export type GuardVerdict = { allowed: true } | { allowed: false; reason: string; pack: string }

/**
 * Runs the guard binary and normalizes the outcome. `code` is the process exit
 * code (0 = allow, 1 = deny) or `null` when the process could not run / was
 * killed (spawn error, timeout). Injected in tests to avoid real subprocesses.
 */
export type GuardRunner = (
  bin: string,
  args: string[],
  opts: { timeout: number }
) => Promise<{ code: number | null; stderr: string; timedOut: boolean }>

export interface OperatorGuardOptions {
  /** Resolved saiifeguard binary path, or null when none is bundled. */
  resolveBinary: () => string | null
  /** Currently-enabled opt-in pack ids (core.* are always active in the binary). */
  getPacks: () => string[]
  /** Subprocess seam; defaults to an execFile-backed runner. */
  runner?: GuardRunner
  /** Fail-open backstop in ms; default 2000. */
  timeoutMs?: number
}

export interface OperatorGuard {
  check(command: string): Promise<GuardVerdict>
}

const defaultRunner: GuardRunner = (bin, args, opts) =>
  new Promise((resolve) => {
    execFile(bin, args, { timeout: opts.timeout, encoding: 'utf8' }, (err, _stdout, stderr) => {
      if (err) {
        // execFile sets `killed` when it kills the child on timeout.
        if ((err as NodeJS.ErrnoException & { killed?: boolean }).killed) {
          return resolve({ code: null, stderr: stderr ?? '', timedOut: true })
        }
        // On a normal non-zero exit, `err.code` is the numeric exit code.
        // On a spawn failure (ENOENT, EACCES, or E2BIG/ENAMETOOLONG when the
        // command exceeds the OS ARG_MAX) it is a string errno, not a numeric
        // exit code → treat as null, which makes the guard fail open (allow).
        const code = typeof err.code === 'number' ? err.code : null
        return resolve({ code, stderr: stderr ?? '', timedOut: false })
      }
      resolve({ code: 0, stderr: stderr ?? '', timedOut: false })
    })
  })

function parseDeny(stderr: string): { allowed: false; reason: string; pack: string } {
  // Format: `saiifeguard: BLOCKED by <pack>: <reason>` — pack warnings may share stderr,
  // so match the BLOCKED line specifically. `.` stops at newline, so <reason> is one line.
  const m = /saiifeguard: BLOCKED by (.+?): (.+)/.exec(stderr)
  if (m) return { allowed: false, pack: m[1], reason: m[2].trim() }
  // The deny verdict itself (exit 1) is trusted regardless — only the pack/reason
  // labeling falls back to a generic string here. Log the raw stderr so a saiifeguard
  // release that changed its output format (or produced localized/garbled text)
  // is visible instead of silently mislabeled as "unknown".
  console.warn(
    `saiifeguard: exit 1 (deny) but stderr didn't match the expected "BLOCKED by <pack>: <reason>" format — using a generic label. stderr: ${stderr.slice(0, 200)}`
  )
  return { allowed: false, reason: 'blocked by command guard', pack: 'unknown' }
}

export function makeOperatorGuard(opts: OperatorGuardOptions): OperatorGuard {
  const run = opts.runner ?? defaultRunner
  const timeout = opts.timeoutMs ?? 2000
  return {
    async check(command: string): Promise<GuardVerdict> {
      if (command.trim() === '') return { allowed: true }
      const bin = opts.resolveBinary()
      if (!bin) return { allowed: true }
      const args = ['test', command, ...opts.getPacks().flatMap((p) => ['--pack', p])]
      let res: { code: number | null; stderr: string; timedOut: boolean }
      try {
        res = await run(bin, args, { timeout })
      } catch (err) {
        // Fail-open policy is intentional and unconditional (see module doc),
        // but a genuinely unexpected subprocess failure — distinct from the
        // ENOENT/EACCES cases `defaultRunner` already normalizes to
        // `code: null` — must not vanish with zero trace. Log the
        // malfunction; the verdict stays `allowed: true` either way.
        console.error('saiifeguard: guard runner threw unexpectedly — failing open (allow)', err)
        return { allowed: true } // runner threw → fail open
      }
      if (res.timedOut || res.code === null || res.code === 0) return { allowed: true }
      if (res.code === 1) return parseDeny(res.stderr)
      // An exit code outside the documented 0/1 contract (e.g. a clap parse
      // error, or a broken saiifeguard install) could otherwise mask a persistent
      // guard malfunction as "no policy violations found" forever.
      console.warn(
        `saiifeguard: exited ${res.code} (expected 0 or 1) — failing open (allow). stderr: ${res.stderr.slice(0, 500)}`
      )
      return { allowed: true } // any other exit code → fail open
    }
  }
}
