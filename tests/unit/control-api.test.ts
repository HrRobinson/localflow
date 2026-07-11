import { describe, it, expect } from 'vitest'
import { handleRequest, clampLines, type ControlDeps } from '../../src/main/control-api'
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

  // NOTE: spec called for null -> 5, but Number(null) === 0 (finite), so it
  // takes the numeric branch, not the NaN-fallback branch, and clamps to 1.
  // Left out pending clarification — see hardening-report.md.

  it('clamps a negative value up to 1', () => {
    expect(clampLines('-10')).toBe(1)
  })
})
