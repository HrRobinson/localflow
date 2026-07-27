import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto'
import { applyLoopbackTimeouts } from './server-timeouts'
import type { HookEvent } from '../shared/types'

export interface HookEndpoint {
  port: number
  token: string
  close(): void
}

const EVENT_NAMES = ['UserPromptSubmit', 'Notification', 'Stop', 'PostToolUse'] as const
const MAX_BODY_BYTES = 4096

function sha256(input: string): Buffer {
  return createHash('sha256').update(input).digest()
}

function tokensMatch(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string') return false
  return timingSafeEqual(sha256(provided), sha256(expected))
}

export function parseHookBody(raw: string): HookEvent | null {
  try {
    const data: unknown = JSON.parse(raw)
    if (typeof data !== 'object' || data === null) return null
    const { paneId, event } = data as Record<string, unknown>
    if (typeof paneId !== 'string' || paneId.length === 0) return null
    if (typeof event !== 'string' || !(EVENT_NAMES as readonly string[]).includes(event)) {
      return null
    }
    return { paneId, event: event as HookEvent['event'] }
  } catch {
    return null
  }
}

export function startHookServer(onEvent: (e: HookEvent) => void): Promise<HookEndpoint> {
  const token = randomUUID()
  const server = createServer((req, res) => {
    if (
      req.method !== 'POST' ||
      req.url !== '/event' ||
      !tokensMatch(req.headers['x-saiife-token'], token)
    ) {
      res.writeHead(403)
      res.end()
      return
    }
    let body = ''
    let responded = false
    // A mid-body connection reset emits 'error' on the request stream. With no
    // listener, that 'error' event is unhandled and crashes the main process.
    // Mark responded so 'data'/'end' (which may still be queued) never attempt
    // to write to the now-dead socket.
    req.on('error', () => {
      responded = true
    })
    req.on('data', (chunk: Buffer) => {
      if (responded) return
      body += chunk.toString()
      if (body.length > MAX_BODY_BYTES) {
        responded = true
        res.writeHead(400)
        res.end()
        req.destroy()
      }
    })
    req.on('end', () => {
      if (responded) return
      responded = true
      const event = parseHookBody(body)
      if (!event) {
        res.writeHead(400)
        res.end()
        return
      }
      onEvent(event)
      res.writeHead(204)
      res.end()
    })
  })
  applyLoopbackTimeouts(server)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ port, token, close: () => server.close() })
    })
  })
}
