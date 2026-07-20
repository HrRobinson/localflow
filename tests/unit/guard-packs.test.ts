import { describe, it, expect } from 'vitest'
import {
  GUARD_PACKS,
  DEFAULT_ON_PACK_IDS,
  OPT_IN_PACK_IDS,
  resolveActivePacks,
  resolveOptInPackArgs,
  isKnownGuardPack
} from '../../src/shared/guard-packs'

describe('guard-pack catalog', () => {
  it('marks exactly the core.* packs as default-on', () => {
    for (const p of GUARD_PACKS) {
      expect(p.defaultOn).toBe(p.id.startsWith('core.'))
    }
    // Both flavours are represented.
    expect(DEFAULT_ON_PACK_IDS).toEqual(['core.filesystem', 'core.git'])
    expect(OPT_IN_PACK_IDS.length).toBeGreaterThan(0)
    expect(OPT_IN_PACK_IDS.every((id) => !id.startsWith('core.'))).toBe(true)
  })

  it('has unique ids and disjoint default-on / opt-in sets', () => {
    const ids = GUARD_PACKS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    const optIn = new Set(OPT_IN_PACK_IDS)
    expect(DEFAULT_ON_PACK_IDS.some((id) => optIn.has(id))).toBe(false)
  })

  it('registers every built-in pack the Rust side ships (kept in sync with builtins.rs)', () => {
    // If a pack is added/removed in builtins.rs, update this list too.
    expect(GUARD_PACKS.map((p) => p.id).sort()).toEqual(
      [
        'cloud.aws',
        'cloud.azure',
        'cloud.gcloud',
        'container.docker',
        'container.k8s',
        'core.filesystem',
        'core.git',
        'db.mongo',
        'db.mysql',
        'db.postgres',
        'iac.terraform'
      ].sort()
    )
  })
})

describe('resolveActivePacks (mirror of Rust select_active)', () => {
  it('activates the default-on packs even with an empty enabled list', () => {
    expect(resolveActivePacks([])).toEqual(['core.filesystem', 'core.git'])
  })

  it('adds enabled opt-in packs on top of the default-on set', () => {
    expect(resolveActivePacks(['cloud.gcloud'])).toEqual([
      'core.filesystem',
      'core.git',
      'cloud.gcloud'
    ])
  })

  it('ignores unknown ids', () => {
    expect(resolveActivePacks(['nope', 'db.mysql', 'also.bogus'])).toEqual([
      'core.filesystem',
      'core.git',
      'db.mysql'
    ])
  })

  it('cannot be tricked into "disabling" a default-on pack via the enabled list', () => {
    // Passing a core.* id changes nothing; core.* are always active.
    expect(resolveActivePacks(['core.git'])).toEqual(['core.filesystem', 'core.git'])
  })
})

describe('resolveOptInPackArgs (what gets passed to the binary as --pack)', () => {
  it('is empty when nothing opt-in is enabled', () => {
    expect(resolveOptInPackArgs([])).toEqual([])
  })

  it('returns only the enabled, known opt-in ids', () => {
    expect(resolveOptInPackArgs(['cloud.aws', 'container.docker'])).toEqual([
      'cloud.aws',
      'container.docker'
    ])
  })

  it('strips default-on ids (the binary applies core.* itself)', () => {
    expect(resolveOptInPackArgs(['core.git', 'core.filesystem', 'db.mongo'])).toEqual(['db.mongo'])
  })

  it('drops unknown/typo ids so they never become bogus --pack args', () => {
    expect(resolveOptInPackArgs(['cloud.gpc', 'cloud.gcloud'])).toEqual(['cloud.gcloud'])
  })

  it('de-duplicates and yields a deterministic (catalog) order', () => {
    expect(resolveOptInPackArgs(['db.mysql', 'cloud.aws', 'db.mysql'])).toEqual([
      'cloud.aws',
      'db.mysql'
    ])
  })
})

describe('isKnownGuardPack', () => {
  it('recognizes catalog ids and rejects the rest', () => {
    expect(isKnownGuardPack('core.git')).toBe(true)
    expect(isKnownGuardPack('container.k8s')).toBe(true)
    expect(isKnownGuardPack('nope')).toBe(false)
  })
})
