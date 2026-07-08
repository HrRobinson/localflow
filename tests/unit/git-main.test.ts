import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { confinePath, gitDiff, gitStatus } from '../../src/main/git'

/** A fresh real git repo in a temp dir (realpath'd — macOS tmpdir is a symlink). */
function makeRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'localflow-git-')))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  return dir
}

describe('confinePath', () => {
  const top = `${sep}repo${sep}top`

  it('accepts a legit repo-relative path, returning it absolute', () => {
    expect(confinePath(top, 'src/main.ts')).toBe(join(top, 'src/main.ts'))
  })

  it('accepts a nested path with redundant segments (normalized)', () => {
    expect(confinePath(top, 'src/./a/../b.ts')).toBe(join(top, 'src/b.ts'))
  })

  it('accepts an absolute path already inside the toplevel', () => {
    expect(confinePath(top, join(top, 'deep/file'))).toBe(join(top, 'deep/file'))
  })

  it('accepts a dotdot-prefixed FILENAME inside the repo (..hidden)', () => {
    expect(confinePath(top, '..hidden')).toBe(join(top, '..hidden'))
  })

  it('rejects an absolute path outside the repo', () => {
    expect(confinePath(top, '/etc/hosts')).toBeNull()
  })

  it('rejects ../ traversal escaping the toplevel', () => {
    expect(confinePath(top, '../outside.txt')).toBeNull()
    expect(confinePath(top, 'src/../../outside.txt')).toBeNull()
    expect(confinePath(top, '../../../../etc/hosts')).toBeNull()
  })

  it('rejects a path equal to the toplevel itself', () => {
    expect(confinePath(top, '.')).toBeNull()
    expect(confinePath(top, top)).toBeNull()
    expect(confinePath(top, 'src/..')).toBeNull()
  })

  it('rejects anything under the .git directory', () => {
    expect(confinePath(top, '.git')).toBeNull()
    expect(confinePath(top, '.git/config')).toBeNull()
    expect(confinePath(top, join(top, '.git/config'))).toBeNull()
    expect(confinePath(top, '.git/hooks/pre-commit')).toBeNull()
  })

  it('accepts files whose name only starts with .git (exact-segment match)', () => {
    expect(confinePath(top, '.gitignore')).toBe(join(top, '.gitignore'))
    expect(confinePath(top, '.github/workflows/x.yml')).toBe(join(top, '.github/workflows/x.yml'))
  })

  it('rejects NUL bytes in either argument', () => {
    expect(confinePath(top, 'a\0b')).toBeNull()
    expect(confinePath(`${top}\0`, 'a')).toBeNull()
  })

  it('rejects empty inputs', () => {
    expect(confinePath(top, '')).toBeNull()
    expect(confinePath('', 'a')).toBeNull()
  })
})

describe('gitStatus (real git)', () => {
  it('reports repo:false for a non-repo directory', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'localflow-norepo-')))
    expect(await gitStatus(dir)).toEqual({ repo: false })
  })

  it('reports an untracked file in a fresh repo', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'newfile.txt'), 'hello\n')
    const st = await gitStatus(repo)
    expect(st.repo).toBe(true)
    if (st.repo) {
      const entry = st.files.find((f) => f.path === 'newfile.txt')
      expect(entry?.untracked).toBe(true)
    }
  })

  it('never throws on a NUL-poisoned cwd (execFile rejection funneled)', async () => {
    expect(await gitStatus('/tmp/\0bad')).toEqual({ repo: false })
  })
})

describe('gitDiff (real git)', () => {
  it('does NOT leak a file outside the repo via an absolute path', async () => {
    const repo = makeRepo()
    // A readable secret OUTSIDE the repo, created by this test.
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'localflow-outside-')))
    const secret = join(outside, 'secret.txt')
    writeFileSync(secret, 'TOP-SECRET-CONTENTS\n')
    const res = await gitDiff(repo, secret, false)
    expect(res).toEqual({ text: '', truncated: false })
    // And the classic PoC target.
    const hosts = await gitDiff(repo, '/etc/hosts', false)
    expect(hosts).toEqual({ text: '', truncated: false })
  })

  it('does NOT leak .git/config (in-repo but never a status path)', async () => {
    const repo = makeRepo()
    const res = await gitDiff(repo, join(repo, '.git/config'), false)
    expect(res).toEqual({ text: '', truncated: false })
  })

  it('does NOT leak ../ traversal out of the repo', async () => {
    const repo = makeRepo()
    const parentFile = join(repo, '..', 'escape.txt')
    writeFileSync(parentFile, 'ESCAPED\n')
    const res = await gitDiff(repo, '../escape.txt', false)
    expect(res).toEqual({ text: '', truncated: false })
  })

  it('still renders an untracked file INSIDE the repo as full additions', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'newfile.txt'), 'line one\nline two\n')
    const res = await gitDiff(repo, 'newfile.txt', false)
    expect(res.truncated).toBe(false)
    expect(res.text).toContain('+line one')
    expect(res.text).toContain('+line two')
    expect(res.text).toContain('/dev/null')
  })

  it('returns the friendly empty result for a non-repo cwd', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'localflow-norepo-')))
    expect(await gitDiff(dir, 'anything.txt', false)).toEqual({ text: '', truncated: false })
  })

  it('never throws on a NUL-poisoned path', async () => {
    const repo = makeRepo()
    expect(await gitDiff(repo, 'a\0b', false)).toEqual({ text: '', truncated: false })
  })
})
