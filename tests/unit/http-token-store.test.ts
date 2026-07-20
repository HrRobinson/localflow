import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CredentialStore, type SecretBackend } from '../../src/main/integrations/credential-store'
import { HttpTokenStore, httpSecretKey } from '../../src/main/http/http-token-store'

const backend: SecretBackend = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s, 'utf8'),
  decryptString: (b) => b.toString('utf8')
}

function stores(): { creds: CredentialStore; store: HttpTokenStore } {
  const dir = mkdtempSync(join(tmpdir(), 'lf-http-tok-'))
  const creds = new CredentialStore({ backend, file: join(dir, 'secrets.enc') })
  return { creds, store: new HttpTokenStore(creds) }
}

describe('HttpTokenStore', () => {
  it('round-trips a node secret and reports presence', () => {
    const { creds, store } = stores()
    creds.set('http', httpSecretKey('orders', 'webhookSecret'), 'whsec_orders_value')
    expect(store.revealNodeSecret('orders', 'webhookSecret')).toBe('whsec_orders_value')
    expect(store.hasNodeSecret('orders', 'webhookSecret')).toBe(true)
  })

  /** ★ The composite key was built as `http:<nodeId>:<secretRef>` with a raw,
   *  unescaped `:` delimiter between the two attacker/author-controlled
   *  segments. Two DIFFERENT (nodeId, secretRef) pairs whose naive
   *  concatenation is byte-identical land on the SAME keychain entry, so
   *  storing node B's secret silently overwrites (and later reveals as) node
   *  A's. Reproduces the exact colliding pair from the review finding —
   *  ("orders", "shopify:webhookSecret") vs ("orders:shopify",
   *  "webhookSecret") — and proves the fix keeps them on distinct entries. */
  it('does not collide two different (nodeId, secretRef) pairs across the `:` delimiter', () => {
    expect(httpSecretKey('orders', 'shopify:webhookSecret')).not.toBe(
      httpSecretKey('orders:shopify', 'webhookSecret')
    )
  })

  it('round-trips both halves of the colliding pair to distinct, correct values', () => {
    const { creds, store } = stores()

    creds.set('http', httpSecretKey('orders', 'shopify:webhookSecret'), 'secret-for-orders-node')
    creds.set(
      'http',
      httpSecretKey('orders:shopify', 'webhookSecret'),
      'secret-for-orders-shopify-node'
    )

    expect(store.revealNodeSecret('orders', 'shopify:webhookSecret')).toBe('secret-for-orders-node')
    expect(store.revealNodeSecret('orders:shopify', 'webhookSecret')).toBe(
      'secret-for-orders-shopify-node'
    )
    // Clearing/overwriting one must never touch the other.
    creds.set('http', httpSecretKey('orders', 'shopify:webhookSecret'), 'rotated-orders-secret')
    expect(store.revealNodeSecret('orders', 'shopify:webhookSecret')).toBe('rotated-orders-secret')
    expect(store.revealNodeSecret('orders:shopify', 'webhookSecret')).toBe(
      'secret-for-orders-shopify-node'
    )
  })

  it('surfaces a legible error (never the ciphertext) when nothing is stored', () => {
    const { store } = stores()
    expect(() => store.revealNodeSecret('orders', 'webhookSecret')).toThrow(/No "http" credential/)
  })
})
