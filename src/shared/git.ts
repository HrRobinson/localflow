/**
 * Pure git helpers shared by main (which runs git) and the renderer (which
 * renders the result). No I/O here — the porcelain parser, the diff size-cap,
 * and the per-line diff classifier are all pure functions so they can be
 * unit-tested without a real repo.
 */

/** One entry from `git status --porcelain=v1`. */
export interface GitFileEntry {
  /** Path relative to the repo root (the NEW path for a rename/copy). */
  path: string
  /** Original path for a rename/copy, else undefined. */
  origPath?: string
  /** Index (staged) status char X; ' ' when clean, '?' when untracked. */
  index: string
  /** Worktree (unstaged) status char Y; ' ' when clean, '?' when untracked. */
  worktree: string
  /** Has staged (index) changes. */
  staged: boolean
  /** Has unstaged (worktree) changes. */
  unstaged: boolean
  /** Untracked ('??' in porcelain). */
  untracked: boolean
}

/** `repo: false` means the cwd is not a git repo (or the session has no cwd). */
export type GitStatus = { repo: false } | { repo: true; files: GitFileEntry[] }

/** One diff layer's text, flagged when the size-cap trimmed it. */
export interface DiffResult {
  text: string
  truncated: boolean
}

/** Whether an escape-hatch tool resolved on PATH, with a hint when it didn't. */
export interface ToolAvailability {
  path: string | null
  available: boolean
  hint?: string
}

/** lazygit + editor availability, probed in main. `editor.command` is the raw config value. */
export interface Capabilities {
  lazygit: ToolAvailability
  editor: ToolAvailability & { command: string }
}

export type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'context'

/** Diff text past this many characters is truncated with a fallback message. */
export const DIFF_MAX_CHARS = 200_000

/**
 * Parse `git status --porcelain=v1` output. Each line is `XY<space>PATH`
 * (`XY ORIG -> PATH` for a rename/copy). Untracked is `?? PATH`. The parser is
 * lenient: blank/short lines are skipped, and a rename's current path (the side
 * git diff wants) is taken as the right of ` -> `. The arrow is only a path
 * separator for rename/copy entries (X or Y is R/C) — for any other status,
 * ` -> ` in the text is a literal part of the filename.
 */
export function parsePorcelain(stdout: string): GitFileEntry[] {
  const entries: GitFileEntry[] = []
  for (const raw of stdout.split('\n')) {
    if (raw.length < 4) continue // need at least "XY p"
    const index = raw[0]
    const worktree = raw[1]
    const rest = raw.slice(3) // char 2 is the separating space
    const untracked = index === '?' && worktree === '?'
    let path = rest
    let origPath: string | undefined
    const renamedOrCopied = index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C'
    const arrow = renamedOrCopied ? rest.indexOf(' -> ') : -1
    if (arrow !== -1) {
      origPath = rest.slice(0, arrow)
      path = rest.slice(arrow + 4)
    }
    entries.push({
      path,
      origPath,
      index,
      worktree,
      untracked,
      staged: !untracked && index !== ' ',
      unstaged: !untracked && worktree !== ' '
    })
  }
  return entries
}

/** Trim diff text to the cap, flagging truncation. Length is by JS chars. */
export function capDiff(raw: string, maxChars: number = DIFF_MAX_CHARS): DiffResult {
  if (raw.length <= maxChars) return { text: raw, truncated: false }
  return { text: raw.slice(0, maxChars), truncated: true }
}

/**
 * Classify one unified-diff line for coloring. File-header lines (`+++`/`---`,
 * `diff --git`, `index`, mode/rename metadata, `Binary …`) are 'meta' so they
 * never get miscolored as additions/removals — checked BEFORE the `+`/`-`
 * content tests.
 */
export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith('@@')) return 'hunk'
  if (
    line.startsWith('+++') ||
    line.startsWith('---') ||
    line.startsWith('diff ') ||
    line.startsWith('index ') ||
    line.startsWith('new file') ||
    line.startsWith('deleted file') ||
    line.startsWith('rename ') ||
    line.startsWith('copy ') ||
    line.startsWith('similarity ') ||
    line.startsWith('dissimilarity ') ||
    line.startsWith('old mode') ||
    line.startsWith('new mode') ||
    line.startsWith('Binary ')
  ) {
    return 'meta'
  }
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'context'
}
