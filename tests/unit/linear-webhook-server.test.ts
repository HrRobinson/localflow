import { describe, it, expect, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  parseLinearEvent,
  startLinearWebhookServer,
  LINEAR_MAX_BODY_BYTES,
  type LinearWebhookServer
} from '../../src/main/linear/linear-webhook-server'
import type { LinearSessionEvent } from '../../src/shared/linear'

const SECRET = 'whsec_test_secret_value'

function sign(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

const flush = () => new Promise<void>((r) => setImmediate(r))

describe('parseLinearEvent', () => {
  it('parses a created event with issue + promptContext', () => {
    const raw = JSON.stringify({
      action: 'created',
      agentSession: {
        id: 'sess-1',
        issue: { id: 'iss-1', identifier: 'ENG-1', title: 'Do the thing' },
        promptContext: 'Please do the thing.'
      }
    })
    expect(parseLinearEvent(raw)).toEqual<LinearSessionEvent>({
      action: 'created',
      agentSession: {
        id: 'sess-1',
        issue: { id: 'iss-1', identifier: 'ENG-1', title: 'Do the thing' },
        promptContext: 'Please do the thing.'
      }
    })
  })

  it('parses a prompted event carrying the human follow-up', () => {
    const raw = JSON.stringify({
      action: 'prompted',
      agentSession: { id: 'sess-1' },
      agentActivity: { content: { body: 'Yes, go ahead.' } }
    })
    const e = parseLinearEvent(raw)
    expect(e?.action).toBe('prompted')
    expect(e?.prompt).toBe('Yes, go ahead.')
  })

  it('rejects unknown actions, missing session id, and bad JSON', () => {
    expect(
      parseLinearEvent(JSON.stringify({ action: 'deleted', agentSession: { id: 'x' } }))
    ).toBeNull()
    expect(parseLinearEvent(JSON.stringify({ action: 'created', agentSession: {} }))).toBeNull()
    expect(parseLinearEvent(JSON.stringify({ action: 'created' }))).toBeNull()
    expect(parseLinearEvent('not json')).toBeNull()
  })
})

describe('startLinearWebhookServer', () => {
  let server: LinearWebhookServer
  afterEach(() => server?.close())

  async function post(body: string, headers: Record<string, string>) {
    const url = `http://127.0.0.1:${server.port}/linear/webhook`
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body
    })
  }

  it('delivers a valid, signed created event to the handler and 200s', async () => {
    const received: LinearSessionEvent[] = []
    server = await startLinearWebhookServer({ secret: SECRET })
    server.onEvent((e) => received.push(e))

    const body = JSON.stringify({ action: 'created', agentSession: { id: 'sess-1' } })
    const res = await post(body, { 'linear-signature': sign(body) })
    await flush()

    expect(res.status).toBe(200)
    expect(received).toHaveLength(1)
    expect(received[0].agentSession.id).toBe('sess-1')
  })

  it('delivers a valid, signed prompted event with the reply text', async () => {
    const received: LinearSessionEvent[] = []
    server = await startLinearWebhookServer({ secret: SECRET })
    server.onEvent((e) => received.push(e))

    const body = JSON.stringify({
      action: 'prompted',
      agentSession: { id: 'sess-1' },
      agentActivity: { content: { body: 'proceed' } }
    })
    const res = await post(body, { 'linear-signature': sign(body) })
    await flush()

    expect(res.status).toBe(200)
    expect(received[0]?.prompt).toBe('proceed')
  })

  it('rejects an invalid HMAC signature (401) and never calls the handler', async () => {
    const received: LinearSessionEvent[] = []
    server = await startLinearWebhookServer({ secret: SECRET })
    server.onEvent((e) => received.push(e))

    const body = JSON.stringify({ action: 'created', agentSession: { id: 'sess-1' } })
    const res = await post(body, { 'linear-signature': sign(body, 'wrong-secret') })
    await flush()

    expect(res.status).toBe(401)
    expect(received).toHaveLength(0)
  })

  it('rejects a missing signature (401)', async () => {
    const received: LinearSessionEvent[] = []
    server = await startLinearWebhookServer({ secret: SECRET })
    server.onEvent((e) => received.push(e))

    const body = JSON.stringify({ action: 'created', agentSession: { id: 'sess-1' } })
    const res = await post(body, {})
    await flush()

    expect(res.status).toBe(401)
    expect(received).toHaveLength(0)
  })

  it('rejects oversized bodies before verifying or parsing', async () => {
    const received: LinearSessionEvent[] = []
    server = await startLinearWebhookServer({ secret: SECRET })
    server.onEvent((e) => received.push(e))

    const huge = 'x'.repeat(LINEAR_MAX_BODY_BYTES + 1)
    const body = JSON.stringify({ action: 'created', agentSession: { id: 'sess-1' }, pad: huge })
    const res = await post(body, { 'linear-signature': sign(body) })
    await flush()

    expect(res.status).toBe(413)
    expect(received).toHaveLength(0)
  })

  it('rejects well-signed but malformed JSON (400)', async () => {
    const received: LinearSessionEvent[] = []
    server = await startLinearWebhookServer({ secret: SECRET })
    server.onEvent((e) => received.push(e))

    const body = 'definitely not json'
    const res = await post(body, { 'linear-signature': sign(body) })
    await flush()

    expect(res.status).toBe(400)
    expect(received).toHaveLength(0)
  })

  it('rejects a wrong path or method (404)', async () => {
    server = await startLinearWebhookServer({ secret: SECRET })
    const res = await fetch(`http://127.0.0.1:${server.port}/nope`, { method: 'GET' })
    expect(res.status).toBe(404)
  })

  it('never writes the signing secret or the raw body into any log line', async () => {
    const logs: string[] = []
    server = await startLinearWebhookServer({ secret: SECRET, log: (m) => logs.push(m) })
    server.onEvent(() => {
      throw new Error('handler blew up')
    })

    // A forged signature (logged as a rejection) …
    const body = JSON.stringify({ action: 'created', agentSession: { id: 'secret-body-marker' } })
    await post(body, { 'linear-signature': sign(body, 'wrong') })
    // … and a handler that throws (logged as a route+reason failure).
    await post(body, { 'linear-signature': sign(body) })
    await flush()

    expect(logs.length).toBeGreaterThan(0)
    const joined = logs.join('\n')
    expect(joined).not.toContain(SECRET)
    expect(joined).not.toContain('secret-body-marker')
  })
})
