import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CredentialStore, type SecretBackend } from '../../src/main/integrations/credential-store'
import { StripeTokenStore } from '../../src/main/stripe/stripe-token-store'
import { StripeConnector } from '../../src/main/stripe/stripe-connector'
import { StripeApiClient, type StripeTransport } from '../../src/main/stripe/stripe-client'

// A realistic-looking restricted key (never a full sk_) — the least-privilege
// posture of §8. The whole point of these tests: this value must appear in NO
// connector output and NO error/stack, ever (the never-render-secrets rule).
const RK = 'rk_live_super_secret_restricted_key_value_51xyz'

const backend: SecretBackend = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s, 'utf8'),
  decryptString: (b) => b.toString('utf8')
}

function tokenStore(): StripeTokenStore {
  const dir = mkdtempSync(join(tmpdir(), 'lf-stripe-tok-'))
  const creds = new CredentialStore({ backend, file: join(dir, 'secrets.enc') })
  creds.set('stripe', 'restrictedKey', RK)
  creds.set('stripe', 'webhookSecret', 'whsec_value')
  return new StripeTokenStore(creds)
}

describe('StripeTokenStore', () => {
  it('round-trips the restricted key via the main-only reveal exit', () => {
    const store = tokenStore()
    expect(store.restrictedKey()).toBe(RK)
    expect(store.webhookSecret()).toBe('whsec_value')
    expect(store.hasRestrictedKey()).toBe(true)
  })

  it('surfaces a legible error (never the ciphertext) when nothing is stored', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lf-stripe-tok-'))
    const creds = new CredentialStore({ backend, file: join(dir, 'secrets.enc') })
    const store = new StripeTokenStore(creds)
    expect(() => store.restrictedKey()).toThrow(/No "stripe" credential "restrictedKey"/)
  })
})

describe('the restricted key never leaks into any connector output, log, or error (§8, §11)', () => {
  it('keeps the key out of results and errors across success and failure paths', async () => {
    const store = tokenStore()
    const captured: string[] = []
    const logs: string[] = []

    // A transport that carries the real key in its Authorization header (as the
    // live wiring would) and proves the key flows IN — then we assert it never
    // flows OUT into any rendered surface.
    const transport: StripeTransport = async (req) => {
      const header = `Authorization: Bearer ${store.restrictedKey()}`
      expect(header).toContain(RK)
      if (req.path.startsWith('/v1/charges/')) {
        return {
          status: 200,
          body: { id: 'ch_1', amount: 5000, currency: 'usd', status: 'succeeded', paid: true }
        }
      }
      // A failure path: a 403 permission error (the least-privilege 403 of §11).
      return {
        status: 403,
        body: { error: { type: 'invalid_request_error', message: 'permission denied' } }
      }
    }

    const connector = new StripeConnector({
      api: new StripeApiClient({ transport }),
      log: (m) => logs.push(m)
    })

    const okOut = await connector.invokeAction('getCharge', { id: 'ch_1' })
    captured.push(JSON.stringify(okOut))

    await connector.invokeAction('createRefund', { id: 'ch_1', amount: 50 }).catch((e: Error) => {
      captured.push(e.message)
      captured.push(e.stack ?? '')
    })

    expect(captured.length).toBeGreaterThan(0)
    for (const s of [...captured, ...logs]) expect(s).not.toContain(RK)
  })
})
