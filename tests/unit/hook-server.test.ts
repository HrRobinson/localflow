import { describe, it, expect, afterEach } from 'vitest'
import { request as httpRequest } from 'node:http'
import { parseHookBody, startHookServer, type HookEndpoint } from '../../src/main/hook-server'
import type { HookEvent } from '../../src/shared/types'

describe('parseHookBody', () => {
  it('parses a valid event', () => {
    expect(parseHookBody('{"paneId":"abc","event":"Stop"}')).toEqual({
      paneId: 'abc',
      event: 'Stop'
    })
  })
  it('rejects unknown event names', () => {
    expect(parseHookBody('{"paneId":"abc","event":"Evil"}')).toBeNull()
  })
  it('rejects missing paneId and invalid JSON', () => {
    expect(parseHookBody('{"event":"Stop"}')).toBeNull()
    expect(parseHookBody('not json')).toBeNull()
  })
  it('accepts PostToolUse as a valid event', () => {
    expect(parseHookBody(JSON.stringify({ paneId: 'p1', event: 'PostToolUse' }))).toEqual({
      paneId: 'p1',
      event: 'PostToolUse'
    })
  })
})

describe('startHookServer', () => {
  let endpoint: HookEndpoint
  afterEach(() => endpoint?.close())

  it('delivers valid events and enforces the token', async () => {
    const received: HookEvent[] = []
    endpoint = await startHookServer((e) => received.push(e))
    const url = `http://127.0.0.1:${endpoint.port}/event`
    const body = JSON.stringify({ paneId: 'p1', event: 'Notification' })

    const ok = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Saiife-Token': endpoint.token },
      body
    })
    expect(ok.status).toBe(204)
    expect(received).toEqual([{ paneId: 'p1', event: 'Notification' }])

    const badToken = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Saiife-Token': 'wrong' },
      body
    })
    expect(badToken.status).toBe(403)

    const badBody = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Saiife-Token': endpoint.token },
      body: 'nope'
    })
    expect(badBody.status).toBe(400)
    expect(received).toHaveLength(1)
  })

  it('rejects oversized request bodies', async () => {
    const received: HookEvent[] = []
    endpoint = await startHookServer((e) => received.push(e))
    const url = `http://127.0.0.1:${endpoint.port}/event`
    const oversized = JSON.stringify({
      paneId: 'p1',
      event: 'Notification',
      padding: 'x'.repeat(5000)
    })

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Saiife-Token': endpoint.token },
      body: oversized
    })
    expect(res.status).toBe(400)
    expect(received).toHaveLength(0)
  })

  it('survives an aborted request (client resets mid-body) and keeps serving', async () => {
    const received: HookEvent[] = []
    endpoint = await startHookServer((e) => received.push(e))

    // Open a raw request, send headers + a partial body with a valid token,
    // then destroy the socket before the body completes. This must not crash
    // the server with an unhandled 'error' event on the request.
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest({
        hostname: '127.0.0.1',
        port: endpoint.port,
        path: '/event',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Saiife-Token': endpoint.token,
          'Content-Length': '100'
        }
      })
      req.on('error', () => resolve())
      req.on('response', () => reject(new Error('did not expect a response')))
      req.write('{"paneId":"p1"') // partial, well short of Content-Length
      // give the server a tick to start processing, then abort the connection
      setTimeout(() => {
        req.destroy()
        resolve()
      }, 20)
    })

    const url = `http://127.0.0.1:${endpoint.port}/event`
    const ok = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Saiife-Token': endpoint.token },
      body: JSON.stringify({ paneId: 'p2', event: 'Notification' })
    })
    expect(ok.status).toBe(204)
    expect(received).toEqual([{ paneId: 'p2', event: 'Notification' }])
  })
})
