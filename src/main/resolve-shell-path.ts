import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Runs the probe command in the user's login shell and returns its raw stdout.
 * MUST throw on error, non-zero exit, or timeout so the caller can fail open.
 * Injectable so tests never spawn a real shell.
 */
export type ShellRunner = (shell: string, args: string[], timeoutMs: number) => string

export interface ResolveShellPathOptions {
  /** PATH to union against; defaults to process.env.PATH. */
  currentPath?: string
  /** Login shell to probe; defaults to $SHELL, then /bin/zsh. */
  shell?: string
  /** Platform gate — only 'darwin' does real work; defaults to process.platform. */
  platform?: NodeJS.Platform
  /** Home dir for the ~/.local/bin fallback; defaults to os.homedir(). */
  home?: string
  /** Injectable shell runner; defaults to a real, time-bounded execFileSync. */
  runner?: ShellRunner
  /** Hard timeout for the probe, in ms; defaults to 2000. */
  timeoutMs?: number
}

// Wrap the shell's $PATH in unguessable sentinels so a chatty rc file that
// prints banners/noise to stdout can't corrupt the parse — we slice out only
// what sits between the markers.
const SENTINEL_START = '__LOCALFLOW_PATH_START__'
const SENTINEL_END = '__LOCALFLOW_PATH_END__'
const PROBE = `printf '%s%s%s' '${SENTINEL_START}' "$PATH" '${SENTINEL_END}'`

// GUI-launched apps often miss these even when the shell probe fails; ensure
// they're present so `claude` (~/.local/bin) and homebrew tools resolve.
function commonDirs(home: string): string[] {
  return [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin']
}

const defaultRunner: ShellRunner = (shell, args, timeoutMs) =>
  execFileSync(shell, args, {
    timeout: timeoutMs,
    encoding: 'utf8',
    // Never inherit stdin; discard stderr (rc-file warnings) — we only want stdout.
    stdio: ['ignore', 'pipe', 'ignore']
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
 * Resolve the login-shell PATH and union it into the current PATH.
 *
 * macOS GUI apps (Finder/Dock launch) inherit only a minimal PATH, so bare
 * agent commands like `claude` (in ~/.local/bin) can't be found and their pty
 * exits instantly. Running here once at startup and assigning the result to
 * process.env.PATH gives every later pty spawn the terminal's real PATH.
 *
 * Fail-safe by construction: the probe is time-bounded and any error/timeout/
 * empty output falls back to the original PATH — this never throws and the
 * worst case is a PATH unchanged from today. Non-darwin is a pure no-op.
 */
export function resolveShellPath(opts: ResolveShellPathOptions = {}): string {
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
    shellEntries = split(parseProbe(runner(shell, ['-ilc', PROBE], timeoutMs)))
  } catch {
    // Wedged rc file, missing shell, timeout, non-zero exit — fail open.
    shellEntries = []
  }

  // Original entries first (preserve today's resolution priority), then the
  // shell's, then the common-dir fallbacks. Dedup keeps it idempotent.
  return union(split(current), shellEntries, commonDirs(home)).join(':')
}
