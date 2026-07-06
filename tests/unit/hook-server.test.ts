import { describe, it, expect, afterEach } from 'vitest'
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
      headers: { 'Content-Type': 'application/json', 'X-Localflow-Token': endpoint.token },
      body
    })
    expect(ok.status).toBe(204)
    expect(received).toEqual([{ paneId: 'p1', event: 'Notification' }])

    const badToken = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Localflow-Token': 'wrong' },
      body
    })
    expect(badToken.status).toBe(403)

    const badBody = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Localflow-Token': endpoint.token },
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
      headers: { 'Content-Type': 'application/json', 'X-Localflow-Token': endpoint.token },
      body: oversized
    })
    expect(res.status).toBe(400)
    expect(received).toHaveLength(0)
  })
})
