import { describe, it, expect, vi } from 'vitest'
import { request } from 'node:http'
import {
  handleRequest,
  clampLines,
  startControlServer,
  type ControlDeps
} from '../../src/main/control-api'
import { PaneRegistry } from '../../src/main/pane-registry'
import { OperatorGrantStore } from '../../src/main/operator-grant'
import type { SessionInfo } from '../../src/shared/types'
import { CONTROL_MAX_BODY_BYTES } from '../../src/shared/operator'

function session(over: Partial<SessionInfo>): SessionInfo {
  return {
    id: 'x',
    cwd: '/p',
    name: 'p',
    status: 'idle',
    agentId: 'claude',
    command: 'claude',
    environment: 1,
    kind: 'terminal',
    ...over
  }
}

function deps(): { deps: ControlDeps; grants: OperatorGrantStore; writes: string[] } {
  const sessions = [
    session({ id: 'a-term', environment: 1, name: 'termA' }),
    session({ id: 'b-term', environment: 2, name: 'termB' }),
    session({ id: 'dead-term', environment: 1, name: 'termDead', status: 'exited' })
  ]
  const grants = new OperatorGrantStore()
  const writes: string[] = []
  const manager = {
    list: () => sessions,
    get: (id: string) => sessions.find((s) => s.id === id) ?? null,
    write: (_id: string, data: string) => writes.push(data),
    peek: (_id: string, n = 5) => ['line1', 'line2'].slice(0, n)
  }
  return {
    deps: { registry: new PaneRegistry(manager), grants, manager },
    grants,
    writes
  }
}

describe('control-api router', () => {
  it('rejects a missing/invalid token with 403', async () => {
    const { deps: d } = deps()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const r = await handleRequest(d, 'GET', '/panes', 'nope', '')
      expect(r.status).toBe(403)
    } finally {
      warn.mockRestore()
    }
  })

  it('warns on rejected auth with route and reason but never the token', async () => {
    const { deps: d } = deps()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await handleRequest(d, 'GET', '/panes', 'sekret-token-value', '')
      expect(warn).toHaveBeenCalledTimes(1)
      const rejected = warn.mock.calls[0].join(' ')
      expect(rejected).toContain('GET /panes')
      expect(rejected).toContain('unknown token')
      expect(rejected).not.toContain('sekret')

      warn.mockClear()
      await handleRequest(d, 'POST', '/panes/a-term/prompt', '', '')
      expect(warn.mock.calls[0].join(' ')).toContain('missing bearer token')
    } finally {
      warn.mockRestore()
    }
  })

  it('does not warn on an authorized request', async () => {
    const { deps: d, grants } = deps()
    const token = grants.grant(1)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await handleRequest(d, 'GET', '/panes', token, '')
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('lists only the granted environment’s panes', async () => {
    const { deps: d, grants } = deps()
    const token = grants.grant(1)
    const r = await handleRequest(d, 'GET', '/panes', token, '')
    expect(r.status).toBe(200)
    expect((r.json as { panes: { handle: string }[] }).panes.map((p) => p.handle)).toEqual([
      'a-term',
      'dead-term'
    ])
  })

  it('rejects a foreign-environment handle with 404', async () => {
    const { deps: d, grants } = deps()
    const token = grants.grant(1)
    const r = await handleRequest(
      d,
      'POST',
      '/panes/b-term/prompt',
      token,
      JSON.stringify({ text: 'hi' })
    )
    expect(r.status).toBe(404)
  })

  it('prompt writes text plus a trailing carriage return to the pty', async () => {
    const { deps: d, grants, writes } = deps()
    const token = grants.grant(1)
    const r = await handleRequest(
      d,
      'POST',
      '/panes/a-term/prompt',
      token,
      JSON.stringify({ text: 'do it' })
    )
    expect(r.status).toBe(200)
    expect(writes).toEqual(['do it\r'])
  })

  it('prompt to an exited pane returns 409 and does not write', async () => {
    const { deps: d, grants, writes } = deps()
    const token = grants.grant(1)
    const r = await handleRequest(
      d,
      'POST',
      '/panes/dead-term/prompt',
      token,
      JSON.stringify({ text: 'hi' })
    )
    expect(r.status).toBe(409)
    expect(writes).toEqual([])
  })

  it('output returns peeked lines, clamping maxLines', async () => {
    const { deps: d, grants } = deps()
    const token = grants.grant(1)
    const r = await handleRequest(d, 'GET', '/panes/a-term/output?maxLines=1', token, '')
    expect(r.status).toBe(200)
    expect((r.json as { lines: string[] }).lines).toEqual(['line1'])
  })

  it('rejects an oversize body with 400', async () => {
    const { deps: d, grants } = deps()
    const token = grants.grant(1)
    const big = 'x'.repeat(70000)
    const r = await handleRequest(
      d,
      'POST',
      '/panes/a-term/prompt',
      token,
      JSON.stringify({ text: big })
    )
    expect(r.status).toBe(400)
  })

  it('rejects a body whose byte length exceeds the cap even when its UTF-16 length does not', async () => {
    const { deps: d, grants } = deps()
    const token = grants.grant(1)
    // '€' is 1 UTF-16 code unit but 3 UTF-8 bytes: length === cap (passes a
    // code-unit check) while byteLength === 3x cap (must fail a byte check).
    const multibyte = '€'.repeat(CONTROL_MAX_BODY_BYTES)
    expect(multibyte.length).toBe(CONTROL_MAX_BODY_BYTES)
    expect(Buffer.byteLength(multibyte)).toBeGreaterThan(CONTROL_MAX_BODY_BYTES)
    const r = await handleRequest(d, 'GET', '/panes', token, multibyte)
    expect(r.status).toBe(400)
  })
})

describe('control-api streaming server', () => {
  it('rejects an oversize body with the same 400 JSON shape as the router', async () => {
    const { deps: d, grants } = deps()
    const token = grants.grant(1)
    const endpoint = await startControlServer(d)
    try {
      const oversize = Buffer.alloc(CONTROL_MAX_BODY_BYTES + 1, 'x')
      const response = await new Promise<{ status: number; type: string; body: string }>(
        (resolve, reject) => {
          let settled = false
          const req = request(
            {
              host: '127.0.0.1',
              port: endpoint.port,
              method: 'POST',
              path: '/panes/a-term/prompt',
              headers: { authorization: `Bearer ${token}` }
            },
            (res) => {
              const chunks: Buffer[] = []
              res.on('data', (c: Buffer) => chunks.push(c))
              res.on('end', () => {
                settled = true
                resolve({
                  status: res.statusCode ?? 0,
                  type: String(res.headers['content-type']),
                  body: Buffer.concat(chunks).toString('utf8')
                })
              })
            }
          )
          // The server destroys the request mid-stream once the cap is hit, so
          // a write-side reset AFTER the response arrives is expected — only an
          // error before the response completes should fail the test.
          req.on('error', (err) => {
            if (!settled) {
              settled = true
              reject(err)
            }
          })
          req.end(oversize)
        }
      )
      expect(response.status).toBe(400)
      expect(response.type).toContain('application/json')
      expect(JSON.parse(response.body)).toEqual({ error: 'body too large' })
    } finally {
      endpoint.close()
    }
  })
})

describe('clampLines', () => {
  it('clamps below the floor up to 1', () => {
    expect(clampLines('0')).toBe(1)
  })

  it('clamps above the ceiling down to 50', () => {
    expect(clampLines('51')).toBe(50)
  })

  it('passes an in-range value through', () => {
    expect(clampLines('25')).toBe(25)
  })

  it('defaults non-numeric input to 5', () => {
    expect(clampLines('abc')).toBe(5)
  })

  it('defaults null to 5', () => {
    expect(clampLines(null)).toBe(5)
  })

  it('defaults empty string to 5', () => {
    expect(clampLines('')).toBe(5)
  })

  it('clamps a negative value up to 1', () => {
    expect(clampLines('-10')).toBe(1)
  })
})
