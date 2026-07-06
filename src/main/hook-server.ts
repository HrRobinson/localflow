import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import type { HookEvent } from '../shared/types'

export interface HookEndpoint {
  port: number
  token: string
  close(): void
}

const EVENT_NAMES = ['UserPromptSubmit', 'Notification', 'Stop'] as const

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
      req.headers['x-localflow-token'] !== token
    ) {
      res.writeHead(403)
      res.end()
      return
    }
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString()))
    req.on('end', () => {
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
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ port, token, close: () => server.close() })
    })
  })
}
