import { describe, it, expect } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { PatAuth, AppAuth } from '../../src/main/github/github-auth'
import { GitHubRestApi } from '../../src/main/github/github-api'
import { GitHubConnector } from '../../src/main/github/github-connector'
import type { RawPull } from '../../src/main/github/github-normalize'

const PAT = 'github_pat_super_secret_value_1234567890'

describe('PatAuth', () => {
  it('resolves a Bearer header from the reveal exit', async () => {
    const auth = new PatAuth(() => PAT)
    expect(await auth.authHeader()).toBe(`Bearer ${PAT}`)
  })
})

describe('AppAuth — JWT sign + installation-token mint (§8)', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
  const SECRET_TOKEN = 'ghs_installation_token_secret_value'

  it('signs a JWT, mints a token, and returns it as a Bearer header', async () => {
    let seenJwt = ''
    const auth = new AppAuth({
      appId: '123',
      installationId: '456',
      revealPrivateKey: () => pem,
      now: () => 1_000_000_000_000,
      mint: async ({ appJwt, installationId }) => {
        seenJwt = appJwt
        expect(installationId).toBe('456')
        return { token: SECRET_TOKEN, expiresAt: '2099-01-01T00:00:00Z' }
      }
    })
    expect(await auth.authHeader()).toBe(`Bearer ${SECRET_TOKEN}`)
    // A well-formed JWT: three dot-separated base64url segments.
    expect(seenJwt.split('.')).toHaveLength(3)
  })

  it('caches the token in memory and re-mints only after expiry', async () => {
    let mints = 0
    let clock = 1_000_000_000_000
    const auth = new AppAuth({
      appId: '1',
      installationId: '2',
      revealPrivateKey: () => pem,
      now: () => clock,
      mint: () => {
        mints++
        return Promise.resolve({
          token: `tok${mints}`,
          expiresAt: new Date(clock + 3_600_000).toISOString()
        })
      }
    })
    expect(await auth.authHeader()).toBe('Bearer tok1')
    expect(await auth.authHeader()).toBe('Bearer tok1') // cached
    expect(mints).toBe(1)
    clock += 3_600_000 // past expiry
    expect(await auth.authHeader()).toBe('Bearer tok2')
    expect(mints).toBe(2)
  })

  it('a mint failure rejects legibly WITHOUT rendering the key', async () => {
    const auth = new AppAuth({
      appId: '1',
      installationId: '2',
      revealPrivateKey: () => pem,
      mint: () => Promise.reject(new Error('installation not found'))
    })
    await expect(auth.authHeader()).rejects.toThrow(
      /Could not mint a GitHub App installation token/
    )
    await auth.authHeader().catch((e: Error) => {
      expect(e.message).not.toContain('PRIVATE KEY')
      expect(e.message).not.toContain(pem)
    })
  })
})

describe('the token never leaks into any connector output or error (§8, §11)', () => {
  it('keeps the PAT out of results and errors across success and failure paths', async () => {
    const pull: RawPull = {
      number: 42,
      state: 'open',
      merged: false,
      head: { ref: 'x', sha: 's' },
      base: { ref: 'main', repo: { full_name: 'acme/web' } }
    }
    const captured: string[] = []
    const api = new GitHubRestApi({
      auth: new PatAuth(() => PAT),
      transport: {
        // The header the live transport WOULD send — proves the token flows in.
        send: (req) => {
          expect(req.headers.Authorization).toBe(`Bearer ${PAT}`)
          if (req.url.endsWith('/pulls/42')) {
            return Promise.resolve({ status: 200, body: JSON.stringify(pull) })
          }
          return Promise.resolve({ status: 403, body: JSON.stringify({ message: 'no access' }) })
        }
      }
    })
    const c = new GitHubConnector({ api, defaultRepo: { owner: 'acme', repo: 'web' } })

    captured.push(JSON.stringify(await c.invokeAction('getPR', { number: 42 })))
    await c.invokeAction('mergePR', { number: 42 }).catch((e: Error) => {
      captured.push(e.message)
      captured.push(e.stack ?? '')
    })

    expect(captured.length).toBeGreaterThan(0)
    for (const s of captured) expect(s).not.toContain(PAT)
  })
})
