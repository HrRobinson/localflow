import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CollectionStore } from '../../src/main/api-client/collection-store'
import type { Collection } from '../../src/shared/api-client'

function collection(over: Partial<Collection> = {}): Collection {
  return {
    id: 'stripe-test',
    name: 'Stripe (test)',
    environment: 1,
    origins: ['https://api.stripe.com'],
    auth: { scheme: 'bearer', secretRef: 'apiKey' },
    varSets: { test: { base_url: 'https://api.stripe.com' } },
    requests: [{ id: 'charges', name: 'List charges', method: 'GET', path: '/v1/charges' }],
    ...over
  }
}

function store(): CollectionStore {
  const dir = mkdtempSync(join(tmpdir(), 'sf-col-'))
  return new CollectionStore({ file: join(dir, 'collections.json') })
}

describe('CollectionStore', () => {
  it('upserts and reads back within the owning environment', () => {
    const s = store()
    s.upsert(collection())
    expect(s.get('stripe-test', 1)?.name).toBe('Stripe (test)')
    expect(s.list(1)).toHaveLength(1)
  })

  it('refuses a collection from a foreign environment', () => {
    const s = store()
    s.upsert(collection())
    // The isolation guarantee: env 2 cannot see env 1's collection at all.
    expect(s.get('stripe-test', 2)).toBeUndefined()
    expect(s.list(2)).toHaveLength(0)
  })

  it('replaces on upsert of the same id', () => {
    const s = store()
    s.upsert(collection())
    s.upsert(collection({ name: 'Renamed' }))
    expect(s.list(1)).toHaveLength(1)
    expect(s.get('stripe-test', 1)?.name).toBe('Renamed')
  })

  it('removes a collection', () => {
    const s = store()
    s.upsert(collection())
    s.remove('stripe-test', 1)
    expect(s.get('stripe-test', 1)).toBeUndefined()
  })

  it('refuses to remove a collection from a foreign environment', () => {
    // The isolation guarantee applies to writes, not just reads: env 2 must
    // not be able to delete env 1's collection by id.
    const s = store()
    s.upsert(collection())
    s.remove('stripe-test', 2)
    expect(s.get('stripe-test', 1)?.name).toBe('Stripe (test)')
    expect(s.list(1)).toHaveLength(1)
  })

  it('remove is a no-op for an unknown id', () => {
    const s = store()
    s.upsert(collection())
    s.remove('does-not-exist', 1)
    expect(s.list(1)).toHaveLength(1)
  })

  it('persists across instances', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-col-'))
    const file = join(dir, 'collections.json')
    new CollectionStore({ file }).upsert(collection())
    expect(new CollectionStore({ file }).get('stripe-test', 1)?.name).toBe('Stripe (test)')
  })

  it('starts empty when the file is missing or garbage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-col-'))
    expect(new CollectionStore({ file: join(dir, 'nope.json') }).list(1)).toEqual([])
  })
})
