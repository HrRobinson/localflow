import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SalesforceAuth, type TokenMinter } from '../../src/main/salesforce/salesforce-auth'
import { CredentialStore, type SecretBackend } from '../../src/main/integrations/credential-store'
import { SalesforceTokenStore } from '../../src/main/salesforce/salesforce-token-store'

/**
 * The caching / expiry / re-mint discipline is fully tested offline with a mock
 * minter + an injected clock (spec §8, §12) — no live token endpoint. A
 * regression guard asserts NO secret/token value ever appears in an emitted
 * error (the never-render-secrets rule).
 */

const CLIENT_SECRET = 'sfdc_consumer_SECRET_do_not_leak_9f3a'
const ACCESS_TOKEN = '00Dxx!ACCESS_TOKEN_do_not_leak_qZ'

/** A mock minter counting `mint()` calls — stands in for the deferred JWT /
 *  client-credentials token-endpoint POST. */
class MockMinter implements TokenMinter {
  calls = 0
  constructor(
    private readonly result = {
      accessToken: ACCESS_TOKEN,
      instanceUrl: 'https://acme.my.salesforce.com',
      expiresInSeconds: 3600
    }
  ) {}
  mint(): Promise<{ accessToken: string; instanceUrl?: string; expiresInSeconds?: number }> {
    this.calls++
    return Promise.resolve(this.result)
  }
}

describe('SalesforceAuth — mint + cache (client-credentials / JWT-bearer fork)', () => {
  it('mints once, then serves the cached token until it is near expiry', async () => {
    const minter = new MockMinter()
    let clock = 0
    const auth = new SalesforceAuth({ minter, now: () => clock, skewSeconds: 60 })

    expect(await auth.accessToken()).toBe(ACCESS_TOKEN)
    expect(await auth.accessToken()).toBe(ACCESS_TOKEN)
    expect(minter.calls).toBe(1) // cached — no re-mint

    // Advance to just before (expiry - skew): still cached.
    clock = (3600 - 61) * 1000
    await auth.accessToken()
    expect(minter.calls).toBe(1)

    // Past the skew window: a fresh mint.
    clock = (3600 - 59) * 1000
    await auth.accessToken()
    expect(minter.calls).toBe(2)
  })

  it('coalesces concurrent first calls into a SINGLE mint', async () => {
    const minter = new MockMinter()
    const auth = new SalesforceAuth({ minter, now: () => 0 })
    await Promise.all([auth.accessToken(), auth.accessToken(), auth.accessToken()])
    expect(minter.calls).toBe(1)
  })

  it('exposes the instance URL from the token response', async () => {
    const auth = new SalesforceAuth({ minter: new MockMinter(), now: () => 0 })
    expect(await auth.instanceUrl()).toBe('https://acme.my.salesforce.com')
  })
})

describe('SalesforceAuth.withAuth — re-mint EXACTLY once on INVALID_SESSION_ID', () => {
  it('re-mints once and retries when the call throws INVALID_SESSION_ID', async () => {
    const minter = new MockMinter()
    const auth = new SalesforceAuth({ minter, now: () => 0 })
    let attempts = 0
    const out = await auth.withAuth(async (token) => {
      attempts++
      if (attempts === 1) throw new Error('Salesforce rejected the request (INVALID_SESSION_ID)')
      return token
    })
    expect(out).toBe(ACCESS_TOKEN)
    expect(attempts).toBe(2) // one retry
    expect(minter.calls).toBe(2) // exactly one re-mint
  })

  it('does NOT retry a non-session error (propagates the real cause)', async () => {
    const minter = new MockMinter()
    const auth = new SalesforceAuth({ minter, now: () => 0 })
    let attempts = 0
    await expect(
      auth.withAuth(async () => {
        attempts++
        throw new Error('Salesforce rejected the request (MALFORMED_QUERY)')
      })
    ).rejects.toThrow(/MALFORMED_QUERY/)
    expect(attempts).toBe(1)
    expect(minter.calls).toBe(1)
  })

  it('re-mints only ONCE — a persistent INVALID_SESSION_ID still rejects', async () => {
    const minter = new MockMinter()
    const auth = new SalesforceAuth({ minter, now: () => 0 })
    let attempts = 0
    await expect(
      auth.withAuth(async () => {
        attempts++
        throw new Error('INVALID_SESSION_ID')
      })
    ).rejects.toThrow(/INVALID_SESSION_ID/)
    expect(attempts).toBe(2) // original + one retry, not an infinite loop
    expect(minter.calls).toBe(2)
  })
})

/** ★ The load-bearing secret invariant (spec §8, §12): neither the keychain
 *  credential nor the minted access token appears in any emitted error string. */
describe('SalesforceAuth — no secret/token leak', () => {
  it('a real-credential-reading minter that fails never renders the secret or the token', async () => {
    const backend: SecretBackend = {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(s, 'utf8'),
      decryptString: (b) => b.toString('utf8')
    }
    const dir = mkdtempSync(join(tmpdir(), 'lf-sf-auth-'))
    const creds = new CredentialStore({ backend, file: join(dir, 'secrets.enc') })
    creds.set('salesforce', 'clientSecret', CLIENT_SECRET)
    const tokens = new SalesforceTokenStore(creds)

    // A minter that READS the real secret (as the live client-creds POST would)
    // but then the token endpoint rejects — the reject must carry the OAuth reason,
    // NOT the secret and NOT the (already-minted) access token.
    const failingMinter: TokenMinter = {
      mint: () => {
        const secret = tokens.clientSecret() // read at call time (never rendered)
        void secret
        return Promise.reject(
          new Error('Salesforce rejected the request (invalid_client): invalid client credentials')
        )
      }
    }
    const auth = new SalesforceAuth({ minter: failingMinter, now: () => 0 })

    let errMsg = ''
    try {
      await auth.accessToken()
    } catch (e) {
      errMsg = (e as Error).message + '\n' + ((e as Error).stack ?? '')
    }
    expect(errMsg).toMatch(/invalid_client/)
    expect(errMsg).not.toContain(CLIENT_SECRET)
    expect(errMsg).not.toContain(ACCESS_TOKEN)

    // And a SUCCESSFUL mint's token is never in an onward-surfaced value either.
    const okAuth = new SalesforceAuth({ minter: new MockMinter(), now: () => 0 })
    const surfaced = JSON.stringify({ instanceUrl: await okAuth.instanceUrl() })
    expect(surfaced).not.toContain(ACCESS_TOKEN)
  })
})
