import { describe, it, expect } from 'vitest'
import { request } from 'node:http'
import {
  handleRequest,
  clampLines,
  startControlServer,
  type ControlDeps,
  type OperatorPaneRequest
} from '../../src/main/control-api'
import { PaneRegistry } from '../../src/main/pane-registry'
import { OperatorGrantStore } from '../../src/main/operator-grant'
import type { SessionGroup, SessionInfo } from '../../src/shared/types'
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
    session({ id: 'dead-term', environment: 1, name: 'termDead', status: 'exited' }),
    // g1: environment 1, one memberless-cwd pane then one with a real cwd —
    // exercises "first member WITH a non-empty cwd", not just "first member".
    session({ id: 'g1-a', environment: 1, name: 'g1a', groupId: 'g1', cwd: '' }),
    session({ id: 'g1-b', environment: 1, name: 'g1b', groupId: 'g1', cwd: '/proj/g1' }),
    // g2: environment 2 — used to prove a foreign-env groupId is rejected.
    session({ id: 'g2-a', environment: 2, name: 'g2a', groupId: 'g2', cwd: '/proj/g2' }),
    // g3: environment 1, but every member has an empty cwd.
    session({ id: 'g3-a', environment: 1, name: 'g3a', groupId: 'g3', cwd: '' })
  ]
  const groups: SessionGroup[] = [
    { id: 'g1', name: 'Group 1', environment: 1 },
    { id: 'g2', name: 'Group 2', environment: 2 },
    { id: 'g3', name: 'Group 3', environment: 1 }
  ]
  const grants = new OperatorGrantStore()
  const writes: string[] = []
  let nextId = 0
  const manager = {
    list: () => sessions,
    get: (id: string) => sessions.find((s) => s.id === id) ?? null,
    write: (_id: string, data: string) => writes.push(data),
    peek: (_id: string, n = 5) => ['line1', 'line2'].slice(0, n),
    getGroup: (id: string) => groups.find((g) => g.id === id) ?? null
  }
  // Fakes the same contract `index.ts`'s real `operatorCreatePane` upholds:
  // cwd for a terminal pane is derived from the group's members, never from
  // the caller (there is no cwd field on OperatorPaneRequest).
  const panes = {
    create: (environment: number, req: OperatorPaneRequest): SessionInfo | null => {
      if (req.kind === 'browser') {
        return session({
          id: `new-${nextId++}`,
          kind: 'browser',
          environment,
          cwd: '',
          url: req.url,
          groupId: req.groupId
        })
      }
      const cwd = sessions.find(
        (s) => s.groupId === req.groupId && s.environment === environment && s.cwd
      )?.cwd
      if (!cwd) return null
      return session({
        id: `new-${nextId++}`,
        environment,
        agentId: req.agentId,
        command: req.agentId,
        cwd,
        groupId: req.groupId
      })
    }
  }
  return {
    deps: { registry: new PaneRegistry(manager), grants, manager, panes },
    grants,
    writes
  }
}

describe('control-api router', () => {
  it('rejects a missing/invalid token with 403', async () => {
    const { deps: d } = deps()
    const r = await handleRequest(d, 'GET', '/panes', 'nope', '')
    expect(r.status).toBe(403)
  })

  it('lists only the granted environment’s panes', async () => {
    const { deps: d, grants } = deps()
    const token = grants.grant(1)
    const r = await handleRequest(d, 'GET', '/panes', token, '')
    expect(r.status).toBe(200)
    expect((r.json as { panes: { handle: string }[] }).panes.map((p) => p.handle)).toEqual([
      'a-term',
      'dead-term',
      'g1-a',
      'g1-b',
      'g3-a'
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

describe('POST /panes (operator pane creation)', () => {
  it('rejects a missing/invalid token with 403', async () => {
    const { deps: d } = deps()
    const r = await handleRequest(
      d,
      'POST',
      '/panes',
      'nope',
      JSON.stringify({ kind: 'browser', url: 'http://x.test' })
    )
    expect(r.status).toBe(403)
  })

  it('creates a browser pane in the caller’s environment with no groupId', async () => {
    const { deps: d, grants } = deps()
    const token = grants.grant(1)
    const r = await handleRequest(
      d,
      'POST',
      '/panes',
      token,
      JSON.stringify({ kind: 'browser', url: 'http://x.test' })
    )
    expect(r.status).toBe(200)
    expect((r.json as { pane: { kind: string; url?: string } }).pane).toMatchObject({
      kind: 'browser',
      url: 'http://x.test/'
    })
  })

  it('creates a browser pane in an existing group of the caller’s environment', async () => {
    const { deps: d, grants } = deps()
    const token = grants.grant(1)
    const r = await handleRequest(
      d,
      'POST',
      '/panes',
      token,
      JSON.stringify({ kind: 'browser', url: 'http://x.test', groupId: 'g1' })
    )
    expect(r.status).toBe(200)
    expect((r.json as { pane: { kind: string } }).pane.kind).toBe('browser')
  })

  it('creates a terminal pane, pulling cwd from the group’s first non-empty-cwd member', async () => {
    const { deps: d, grants } = deps()
    const token = grants.grant(1)
    const r = await handleRequest(
      d,
      'POST',
      '/panes',
      token,
      JSON.stringify({ kind: 'terminal', agentId: 'claude', groupId: 'g1' })
    )
    expect(r.status).toBe(200)
    expect((r.json as { pane: { cwd: string } }).pane.cwd).toBe('/proj/g1')
  })

  it('rejects a terminal pane whose group members all have an empty cwd', async () => {
    const { deps: d, grants } = deps()
    const token = grants.grant(1)
    const r = await handleRequest(
      d,
      'POST',
      '/panes',
      token,
      JSON.stringify({ kind: 'terminal', agentId: 'claude', groupId: 'g3' })
    )
    expect(r.status).toBe(400)
    expect(r.json).toEqual({ error: 'invalid pane request' })
  })

  it('rejects a groupId belonging to another environment with "unknown group"', async () => {
    const { deps: d, grants } = deps()
    const token = grants.grant(1)
    const r = await handleRequest(
      d,
      'POST',
      '/panes',
      token,
      JSON.stringify({ kind: 'terminal', agentId: 'claude', groupId: 'g2' })
    )
    expect(r.status).toBe(400)
    expect(r.json).toEqual({ error: 'unknown group' })
  })

  it('rejects a nonexistent groupId with the same "unknown group" wording (no existence leak)', async () => {
    const { deps: d, grants } = deps()
    const token = grants.grant(1)
    const r = await handleRequest(
      d,
      'POST',
      '/panes',
      token,
      JSON.stringify({ kind: 'browser', url: 'http://x.test', groupId: 'does-not-exist' })
    )
    expect(r.status).toBe(400)
    expect(r.json).toEqual({ error: 'unknown group' })
  })

  it('rejects an unknown kind with "invalid pane request"', async () => {
    const { deps: d, grants } = deps()
    const token = grants.grant(1)
    const r = await handleRequest(d, 'POST', '/panes', token, JSON.stringify({ kind: 'x' }))
    expect(r.status).toBe(400)
    expect(r.json).toEqual({ error: 'invalid pane request' })
  })

  it('rejects a terminal request missing the required groupId', async () => {
    const { deps: d, grants } = deps()
    const token = grants.grant(1)
    const r = await handleRequest(
      d,
      'POST',
      '/panes',
      token,
      JSON.stringify({ kind: 'terminal', agentId: 'claude' })
    )
    expect(r.status).toBe(400)
    expect(r.json).toEqual({ error: 'invalid pane request' })
  })

  it('rejects a browser request with an invalid url', async () => {
    const { deps: d, grants } = deps()
    const token = grants.grant(1)
    const r = await handleRequest(
      d,
      'POST',
      '/panes',
      token,
      JSON.stringify({ kind: 'browser', url: 'javascript:alert(1)' })
    )
    expect(r.status).toBe(400)
    expect(r.json).toEqual({ error: 'invalid pane request' })
  })

  // Security: an operator grant means "drive this environment's agents", not
  // "run arbitrary shell commands here". `shell` combined with the existing
  // POST /panes/:handle/prompt route (writes text+CR straight to the pty)
  // would hand a granted operator arbitrary RCE in the project dir — an
  // escalation past the grant model's intent. `openclaw` is excluded for the
  // same reason: it's a raw operator-agent preset with no tool-permission
  // gate of its own. claude/codex/gemini are allowed because each carries
  // its own tool-permission gates.
  it('rejects a terminal pane request with agentId "shell"', async () => {
    const { deps: d, grants } = deps()
    const token = grants.grant(1)
    const r = await handleRequest(
      d,
      'POST',
      '/panes',
      token,
      JSON.stringify({ kind: 'terminal', agentId: 'shell', groupId: 'g1' })
    )
    expect(r.status).toBe(400)
    expect(r.json).toEqual({ error: 'invalid pane request' })
  })

  it('rejects a terminal pane request with agentId "openclaw"', async () => {
    const { deps: d, grants } = deps()
    const token = grants.grant(1)
    const r = await handleRequest(
      d,
      'POST',
      '/panes',
      token,
      JSON.stringify({ kind: 'terminal', agentId: 'openclaw', groupId: 'g1' })
    )
    expect(r.status).toBe(400)
    expect(r.json).toEqual({ error: 'invalid pane request' })
  })

  it.each(['claude', 'codex', 'gemini'])(
    'still allows a terminal pane request with agentId %s',
    async (agentId) => {
      const { deps: d, grants } = deps()
      const token = grants.grant(1)
      const r = await handleRequest(
        d,
        'POST',
        '/panes',
        token,
        JSON.stringify({ kind: 'terminal', agentId, groupId: 'g1' })
      )
      expect(r.status).toBe(200)
      expect((r.json as { pane: { kind: string } }).pane.kind).toBe('terminal')
    }
  )
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
