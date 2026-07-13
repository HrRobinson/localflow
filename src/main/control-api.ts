import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { PaneRegistry } from './pane-registry'
import type { OperatorGrantStore } from './operator-grant'
import type { SessionManager } from './session-manager'
import type { BrowserControl } from './browser-control'
import type { CaptureStore } from './capture-store'
import type { WatchpointRegistry } from './watchpoints'
import { CONTROL_MAX_BODY_BYTES, type ActivityEntry } from '../shared/operator'

export interface ControlDeps {
  registry: PaneRegistry
  grants: OperatorGrantStore
  manager: Pick<SessionManager, 'write' | 'peek'>
  onActivity?: (environment: number, entry: ActivityEntry) => void
  // Wired in Layers 2 & 4; absent routes return 404 until then.
  browser?: BrowserControl
  captures?: CaptureStore
  watchpoints?: WatchpointRegistry
}

export interface ControlEndpoint {
  port: number
  close(): void
}

interface Result {
  status: number
  json: unknown
}

function json(status: number, body: unknown): Result {
  return { status, json: body }
}

export function clampLines(raw: string | null): number {
  if (raw === null || raw.trim() === '') return 5
  const n = Number(raw)
  return Math.min(Math.max(Number.isFinite(n) ? Math.trunc(n) : 5, 1), 50)
}

/**
 * The control-API router. Pure over its inputs (no socket), so auth, scoping,
 * and every route are unit-testable. `token` is the raw bearer secret; it must
 * resolve to exactly one environment, and every handle is resolved ONLY within
 * that environment (the isolation guarantee lives in PaneRegistry.resolve).
 */
export async function handleRequest(
  deps: ControlDeps,
  method: string,
  url: string,
  token: string,
  body: string
): Promise<Result> {
  if (Buffer.byteLength(body) > CONTROL_MAX_BODY_BYTES)
    return json(400, { error: 'body too large' })
  const environment = deps.grants.environmentForToken(token)
  if (environment === null) return json(403, { error: 'no grant' })
  deps.grants.markConnected(environment)

  const parsed = new URL(url, 'http://127.0.0.1')
  const path = parsed.pathname
  const record = (route: string, handle?: string, detail?: string): void =>
    deps.onActivity?.(environment, { at: Date.now(), route, handle, detail })

  const readBody = (): Record<string, unknown> => {
    if (!body) return {}
    try {
      const v: unknown = JSON.parse(body)
      return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }

  // GET /panes
  if (method === 'GET' && path === '/panes') {
    record('GET /panes')
    return json(200, { panes: deps.registry.list(environment) })
  }

  // Watchpoint + capture routes (Layer 4) — server-scoped, not per-pane.
  if (path === '/watchpoints') {
    if (!deps.watchpoints) return json(404, { error: 'not enabled' })
    if (method === 'GET') return json(200, { watchpoints: deps.watchpoints.list(environment) })
    if (method === 'POST') {
      const b = readBody()
      const wp = deps.watchpoints.register(environment, b)
      if (!wp) return json(400, { error: 'invalid watchpoint' })
      record('POST /watchpoints', undefined, wp.step)
      return json(201, { id: wp.id })
    }
  }
  if (path === '/captures' && method === 'POST') {
    if (!deps.watchpoints || !deps.captures) return json(404, { error: 'not enabled' })
    const b = readBody()
    const cap = await deps.captures.ingest(environment, b, deps.watchpoints)
    if (!cap) return json(400, { error: 'invalid capture' })
    record('POST /captures', undefined, cap.watchpointId)
    return json(201, { id: cap.id })
  }
  const capMatch = /^\/captures\/([^/]+)$/.exec(path)
  if (capMatch && method === 'GET') {
    if (!deps.captures) return json(404, { error: 'not enabled' })
    const cap = deps.captures.get(environment, capMatch[1])
    return cap ? json(200, { capture: cap }) : json(404, { error: 'unknown capture' })
  }

  // Per-pane routes: /panes/:handle/:verb
  const paneMatch = /^\/panes\/([^/]+)\/([^/]+)$/.exec(path)
  if (paneMatch) {
    const [, handle, verb] = paneMatch
    const session = deps.registry.resolve(handle, environment)
    if (!session) return json(404, { error: 'unknown handle' })

    // Terminal routes (reuse write/peek).
    if (verb === 'prompt' && method === 'POST') {
      if (session.kind !== 'terminal') return json(400, { error: 'not a terminal pane' })
      if (session.status === 'exited') return json(409, { error: 'pane exited' })
      const b = readBody()
      if (typeof b.text !== 'string') return json(400, { error: 'text required' })
      // Attachments are referenced by path in the prompt text by the operator;
      // v1 does not re-inject them separately (screenshot() already returns a
      // path the operator embeds). Write text + submit (carriage return).
      deps.manager.write(handle, `${b.text}\r`)
      record('POST prompt', handle, b.text.slice(0, 80))
      return json(200, { ok: true })
    }
    if (verb === 'output' && method === 'GET') {
      if (session.kind !== 'terminal') return json(400, { error: 'not a terminal pane' })
      record('GET output', handle)
      return json(200, {
        lines: deps.manager.peek(handle, clampLines(parsed.searchParams.get('maxLines')))
      })
    }

    // Browser routes (Layer 2) — need the browser-control dep.
    if (session.kind !== 'browser') return json(400, { error: 'not a browser pane' })
    if (!deps.browser) return json(404, { error: 'browser control not enabled' })
    const b = readBody()
    switch (`${method} ${verb}`) {
      case 'POST navigate': {
        if (typeof b.url !== 'string') return json(400, { error: 'url required' })
        const nav = await deps.browser.navigate(handle, b.url)
        record('POST navigate', handle, b.url)
        return nav.ok ? json(200, { url: nav.url }) : json(400, { error: nav.error })
      }
      case 'POST screenshot': {
        const shot = await deps.browser.screenshot(handle, environment)
        record('POST screenshot', handle, shot.ok ? shot.path : undefined)
        return shot.ok ? json(200, { path: shot.path }) : json(400, { error: shot.error })
      }
      case 'GET cookies': {
        record('GET cookies', handle)
        return json(200, { cookies: await deps.browser.cookies(handle) })
      }
      case 'GET network': {
        record('GET network', handle)
        return json(200, { requests: await deps.browser.network(handle) })
      }
      case 'POST act': {
        const r = await deps.browser.act(handle, b)
        record('POST act', handle, typeof b.selector === 'string' ? b.selector : undefined)
        return r.ok ? json(200, { ok: true }) : json(400, { error: r.error })
      }
    }
  }

  return json(404, { error: 'not found' })
}

/** Bind the loopback control server. One server; the bearer token selects the
 *  environment (via OperatorGrantStore), so a single port serves every grant. */
export function startControlServer(deps: ControlDeps): Promise<ControlEndpoint> {
  const server = createServer((req, res) => {
    const auth = req.headers['authorization']
    const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : ''
    const chunks: Buffer[] = []
    let bytes = 0
    let responded = false
    req.on('error', () => {
      responded = true
    })
    req.on('data', (chunk: Buffer) => {
      if (responded) return
      bytes += chunk.length
      if (bytes > CONTROL_MAX_BODY_BYTES) {
        responded = true
        // Same response shape as the router's own oversize check, so clients
        // see one contract regardless of which layer rejects the body.
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'body too large' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (responded) return
      responded = true
      const body = Buffer.concat(chunks).toString('utf8')
      void handleRequest(deps, req.method ?? 'GET', req.url ?? '/', token, body).then((r) => {
        res.writeHead(r.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(r.json))
      })
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ port, close: () => server.close() })
    })
  })
}
