import { describe, it, expect } from 'vitest'
import { createServer } from 'node:http'
import {
  applyLoopbackTimeouts,
  SOCKET_IDLE_TIMEOUT_MS,
  HEADERS_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS
} from '../../src/main/server-timeouts'

describe('applyLoopbackTimeouts', () => {
  it('sets socket, header and request timeouts on the server', () => {
    const server = createServer()
    applyLoopbackTimeouts(server)
    expect(server.timeout).toBe(SOCKET_IDLE_TIMEOUT_MS)
    expect(server.headersTimeout).toBe(HEADERS_TIMEOUT_MS)
    expect(server.requestTimeout).toBe(REQUEST_TIMEOUT_MS)
    server.close()
  })

  it('keeps every timeout enabled (non-zero) and generous (>= 30s)', () => {
    // Loopback-only servers: the values exist to reap wedged local peers,
    // never to race a legitimate client.
    for (const v of [SOCKET_IDLE_TIMEOUT_MS, HEADERS_TIMEOUT_MS, REQUEST_TIMEOUT_MS]) {
      expect(v).toBeGreaterThanOrEqual(30_000)
    }
    // Headers must complete before the whole-request budget runs out.
    expect(HEADERS_TIMEOUT_MS).toBeLessThanOrEqual(REQUEST_TIMEOUT_MS)
  })
})
