import { describe, it, expect, vi } from 'vitest'
import {
  GitHubRestApi,
  type GitHubResponse,
  type HttpTransport
} from '../../src/main/github/github-api'
import type { GitHubAuth } from '../../src/main/github/github-auth'

const auth: GitHubAuth = { authHeader: () => Promise.resolve('Bearer tok') }
const REPO = { owner: 'acme', repo: 'web' }

function transportOf(res: GitHubResponse | ((req: unknown) => GitHubResponse)): HttpTransport {
  return { send: (req) => Promise.resolve(typeof res === 'function' ? res(req) : res) }
}

describe('GitHubRestApi — reads', () => {
  it('GET issue returns the raw node and sends auth + version headers', async () => {
    const seen: { headers?: Record<string, string>; url?: string } = {}
    const api = new GitHubRestApi({
      auth,
      transport: {
        send: (req) => {
          seen.headers = req.headers
          seen.url = req.url
          return Promise.resolve({ status: 200, body: JSON.stringify({ number: 7 }) })
        }
      }
    })
    const node = await api.issue(REPO, 7)
    expect(node.number).toBe(7)
    expect(seen.url).toBe('https://api.github.com/repos/acme/web/issues/7')
    expect(seen.headers?.Authorization).toBe('Bearer tok')
    expect(seen.headers?.['X-GitHub-Api-Version']).toBeDefined()
  })

  it('searchIssues unwraps items + total_count', async () => {
    const api = new GitHubRestApi({
      auth,
      transport: transportOf({
        status: 200,
        body: JSON.stringify({ items: [{ number: 1 }], total_count: 1 })
      })
    })
    expect(await api.searchIssues('is:open')).toEqual({ items: [{ number: 1 }], total: 1 })
  })
})

describe('GitHubRestApi — error mapping carries the real GitHub cause (§11)', () => {
  it('401 → re-enter the credential', async () => {
    const api = new GitHubRestApi({ auth, transport: transportOf({ status: 401, body: '{}' }) })
    await expect(api.pull(REPO, 1)).rejects.toThrow(/rejected the credential \(401\)/)
  })

  it('403 forwards the scope message', async () => {
    const api = new GitHubRestApi({
      auth,
      transport: transportOf({
        status: 403,
        body: JSON.stringify({ message: 'Resource not accessible' })
      })
    })
    await expect(api.mergePull(REPO, 1, {})).rejects.toThrow(/Resource not accessible/)
  })

  it('404 is actionable, not a bare 404', async () => {
    const api = new GitHubRestApi({ auth, transport: transportOf({ status: 404, body: '{}' }) })
    await expect(api.pull(REPO, 9)).rejects.toThrow(/has no PR #9 in 'acme\/web'/)
  })

  it('405/422 merge conflict forwards the reason', async () => {
    const api = new GitHubRestApi({
      auth,
      transport: transportOf({
        status: 405,
        body: JSON.stringify({ message: 'Pull Request is not mergeable' })
      })
    })
    await expect(api.mergePull(REPO, 1, {})).rejects.toThrow(/not mergeable/)
  })
})

describe('GitHubRestApi — SSRF guard on the GHES baseUrl (§4.5)', () => {
  it('refuses a loopback baseUrl BEFORE any request', async () => {
    const send = vi.fn()
    const api = new GitHubRestApi({
      auth,
      baseUrl: 'https://127.0.0.1/api/v3',
      transport: { send }
    })
    await expect(api.issue(REPO, 1)).rejects.toThrow(/private\/loopback/)
    expect(send).not.toHaveBeenCalled()
  })

  it('refuses a non-https baseUrl', async () => {
    const api = new GitHubRestApi({
      auth,
      baseUrl: 'http://ghe.corp.example.com/api/v3',
      transport: transportOf({ status: 200, body: '{}' })
    })
    await expect(api.issue(REPO, 1)).rejects.toThrow(/must be https/)
  })

  it('a public GHES host passes and reaches the transport', async () => {
    const api = new GitHubRestApi({
      auth,
      baseUrl: 'https://ghe.corp.example.com/api/v3',
      transport: transportOf({ status: 200, body: JSON.stringify({ number: 3 }) })
    })
    expect((await api.pull(REPO, 3)).number).toBe(3)
  })
})

describe('GitHubRestApi — rate-limit backoff (§11)', () => {
  it('retries on a 403 with X-RateLimit-Remaining:0 then succeeds', async () => {
    let n = 0
    const api = new GitHubRestApi({
      auth,
      sleep: () => Promise.resolve(),
      transport: {
        send: () => {
          n++
          if (n === 1) {
            return Promise.resolve({
              status: 403,
              body: '{}',
              headers: { 'x-ratelimit-remaining': '0', 'retry-after': '1' }
            })
          }
          return Promise.resolve({ status: 200, body: JSON.stringify({ number: 5 }) })
        }
      }
    })
    expect((await api.pull(REPO, 5)).number).toBe(5)
    expect(n).toBe(2)
  })
})
