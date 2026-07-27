import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Private walker per file, matching tests/unit/integration-secret-safety.test.ts
// and email-never-send.test.ts — this repo has no shared test util, and the
// extension filter is required because src/renderer has nested directories and
// a non-TS index.html.
function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) yield full
  }
}

const root = join(__dirname, '..', '..', 'src')

describe('security probe: capability material stays in main', () => {
  it('no preload or renderer file references the grant store or its token', () => {
    for (const dir of ['preload', 'renderer']) {
      for (const file of walk(join(root, dir))) {
        const source = readFileSync(file, 'utf8')
        expect(source, `${file} must not name the grant store`).not.toContain('ApiGrantStore')
        expect(source, `${file} must not name the token variable`).not.toContain('SAIIFE_API_TOKEN')
        expect(source, `${file} must not reach the secret store`).not.toContain(
          'CollectionSecretStore'
        )
      }
    }
  })

  it('the API token variable is written in exactly one place', () => {
    const hits: string[] = []
    for (const file of walk(join(root, 'main'))) {
      if (readFileSync(file, 'utf8').includes('SAIIFE_API_TOKEN')) hits.push(file)
    }
    expect(hits).toEqual([join(root, 'main', 'index.ts')])
  })

  it('SAIIFE_API_TOKEN is distinct from the operator SAIIFE_TOKEN', () => {
    // Reusing the operator's variable would hand every operator-aware agent an
    // API capability by accident — the reason two grant stores exist at all.
    const launch = readFileSync(join(root, 'main', 'operator-launch.ts'), 'utf8')
    expect(launch).toContain('SAIIFE_TOKEN')
    expect(launch).not.toContain('SAIIFE_API_TOKEN')
  })
})
