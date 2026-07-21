import { spawn, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Runs the probe command in the user's login shell and returns its raw stdout.
 * MUST reject on error, non-zero exit, or timeout so the caller can fail open.
 * MUST NEVER hang indefinitely: implementations that spawn a real shell need
 * their own internal time bound (see defaultRunner), because resolveShellPath
 * also races the call against timeoutMs itself as a second, independent
 * backstop — so even a misbehaving runner can't block startup.
 * Injectable so tests never spawn a real shell.
 */
export type ShellRunner = (shell: string, args: string[], timeoutMs: number) => Promise<string>

export interface ResolveShellPathOptions {
  /** PATH to union against; defaults to process.env.PATH. */
  currentPath?: string
  /** Login shell to probe; defaults to $SHELL, then /bin/zsh. */
  shell?: string
  /** Platform gate — only 'darwin' does real work; defaults to process.platform. */
  platform?: NodeJS.Platform
  /** Home dir for the ~/.local/bin fallback; defaults to os.homedir(). */
  home?: string
  /** Injectable shell runner; defaults to a real, time-bounded, detached spawn. */
  runner?: ShellRunner
  /** Hard timeout for the probe, in ms; defaults to 2000. */
  timeoutMs?: number
}

// Wrap the shell's $PATH in unguessable sentinels so a chatty rc file that
// prints banners/noise to stdout can't corrupt the parse — we slice out only
// what sits between the markers.
const SENTINEL_START = '__SAIIFE_PATH_START__'
const SENTINEL_END = '__SAIIFE_PATH_END__'
const PROBE = `printf '%s%s%s' '${SENTINEL_START}' "$PATH" '${SENTINEL_END}'`

// GUI-launched apps often miss these even when the shell probe fails; ensure
// they're present so `claude` (~/.local/bin) and homebrew tools resolve.
function commonDirs(home: string): string[] {
  return [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin']
}

/**
 * Spawns the login shell detached (its own process-group leader) so that if
 * an rc file backgrounds a grandchild that inherits the stdout pipe — nvm's
 * lazy-load, direnv, an ssh-agent-style fork, a plain `something &` — killing
 * the whole group on timeout takes the pipe-holder down with it. Node's
 * built-in execFileSync/spawnSync `timeout` option only SIGTERMs the direct
 * child, which is exactly the gotcha this works around: without detached +
 * group-kill, Node would keep blocking on the pipe's EOF long after the
 * shell itself died.
 */
const defaultRunner: ShellRunner = (shell, args, timeoutMs) =>
  new Promise<string>((resolve, reject) => {
    let settled = false
    let child: ChildProcess
    try {
      child = spawn(shell, args, {
        detached: true,
        // Never inherit stdin; discard stderr (rc-file warnings) — stdout only.
        stdio: ['ignore', 'pipe', 'ignore']
      })
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }

    const chunks: Buffer[] = []
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))

    const killProcessGroup = (): void => {
      const pid = child.pid
      if (pid !== undefined) {
        try {
          // Negative pid targets the whole process group (child is the
          // leader thanks to detached:true) so a backgrounded grandchild
          // holding the stdout pipe open dies too, not just the shell.
          process.kill(-pid, 'SIGKILL')
        } catch {
          // Group already gone, race with natural exit, or unsupported — best effort.
        }
      }
      try {
        child.kill('SIGKILL')
      } catch {
        // ignore
      }
    }

    // This timer is the sole source of truth for the wall-clock bound: it
    // fires at timeoutMs regardless of whether the child (or an orphaned
    // grandchild still holding the pipe) has exited, so the promise always
    // settles on time even in the pathological "pipe never closes" case.
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killProcessGroup()
      reject(new Error('shell probe timed out'))
    }, timeoutMs)
    timer.unref?.()

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`shell probe exited with code ${code}`))
        return
      }
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
  })

/** Union entries, dedup, drop empties, preserve first-seen order. */
function union(...lists: string[][]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const list of lists) {
    for (const entry of list) {
      if (entry.length > 0 && !seen.has(entry)) {
        seen.add(entry)
        out.push(entry)
      }
    }
  }
  return out
}

function split(path: string): string[] {
  return path.split(':')
}

/** Slice the PATH the shell printed out from between our sentinels; '' if absent. */
function parseProbe(stdout: string): string {
  const start = stdout.indexOf(SENTINEL_START)
  const end = stdout.indexOf(SENTINEL_END)
  if (start === -1 || end === -1 || end < start) return ''
  return stdout.slice(start + SENTINEL_START.length, end)
}

/**
 * Races a promise against timeoutMs, rejecting if it doesn't settle in time.
 * This is deliberately independent of whatever timeout logic the runner
 * itself implements — it's the backstop that guarantees resolveShellPath
 * can't hang even if a runner (real or injected) never settles at all.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('resolveShellPath: probe timed out')),
      timeoutMs
    )
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    )
  })
}

/**
 * Resolve the login-shell PATH and union it into the current PATH.
 *
 * macOS GUI apps (Finder/Dock launch) inherit only a minimal PATH, so bare
 * agent commands like `claude` (in ~/.local/bin) can't be found and their pty
 * exits instantly. Running here once at startup and assigning the result to
 * process.env.PATH gives every later pty spawn the terminal's real PATH.
 *
 * Fail-safe by construction: the probe is time-bounded and any error/timeout/
 * empty/malformed output falls back to the original PATH — this never
 * throws or rejects, and the worst case is a PATH unchanged from today.
 * Non-darwin is a pure no-op. Async so the wait never blocks the event loop;
 * callers should `await` it before any pane can spawn.
 */
export async function resolveShellPath(opts: ResolveShellPathOptions = {}): Promise<string> {
  const current = opts.currentPath ?? process.env['PATH'] ?? ''
  const platform = opts.platform ?? process.platform
  // Only macOS suffers the GUI-PATH gap; leave Linux/dev untouched.
  if (platform !== 'darwin') return current

  const home = opts.home ?? homedir()
  const shell = opts.shell ?? process.env['SHELL'] ?? '/bin/zsh'
  const runner = opts.runner ?? defaultRunner
  const timeoutMs = opts.timeoutMs ?? 2000

  let shellEntries: string[]
  try {
    const stdout = await withTimeout(runner(shell, ['-ilc', PROBE], timeoutMs), timeoutMs)
    shellEntries = split(parseProbe(stdout))
  } catch {
    // Wedged rc file, missing shell, timeout, non-zero exit, malformed
    // sentinel output — fail open.
    shellEntries = []
  }

  // Original entries first (preserve today's resolution priority), then the
  // shell's, then the common-dir fallbacks. Dedup keeps it idempotent.
  return union(split(current), shellEntries, commonDirs(home)).join(':')
}
