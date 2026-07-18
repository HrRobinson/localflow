import { describe, it, expect, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  startGitHubWebhookServer,
  verifyGitHubSignature,
  type GitHubWebhookServer,
  type GitHubWebhookDelivery
} from '../../src/main/github/github-webhook-server'

const SECRET = 'whsec_test_secret'

/** GitHub sends the hex HMAC-SHA256 over the raw body, prefixed `sha256=`. */
function sign(body: string, secret = SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex')
}

let server: GitHubWebhookServer | undefined
afterEach(() => {
  server?.close()
  server = undefined
})

async function post(
  s: GitHubWebhookServer,
  body: string,
  headers: Record<string, string>
): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${s.port}/github/webhook`, {
    method: 'POST',
    headers,
    body
  })
  return res.status
}

const hdrs = (
  body: string,
  {
    event = 'check_run',
    id = 'del-1',
    sig = sign(body)
  }: Partial<{ event: string; id: string; sig: string }> = {}
): Record<string, string> => ({
  'content-type': 'application/json',
  'x-hub-signature-256': sig,
  'x-github-event': event,
  'x-github-delivery': id
})

describe('verifyGitHubSignature', () => {
  it('accepts a correct hex HMAC-SHA256 with the sha256= prefix', () => {
    const body = '{"action":"opened"}'
    expect(verifyGitHubSignature(Buffer.from(body), sign(body), SECRET)).toBe(true)
  })
  it('rejects a wrong signature, a non-string, and an empty secret', () => {
    const body = '{"action":"opened"}'
    expect(verifyGitHubSignature(Buffer.from(body), sign(body, 'other'), SECRET)).toBe(false)
    expect(verifyGitHubSignature(Buffer.from(body), undefined, SECRET)).toBe(false)
    expect(verifyGitHubSignature(Buffer.from(body), sign(body), '')).toBe(false)
  })
})

describe('github webhook server (shared receiver)', () => {
  it('accepts a valid, signed, novel delivery and emits it once with event + payload', async () => {
    const seen: GitHubWebhookDelivery[] = []
    server = await startGitHubWebhookServer({ secret: SECRET, log: () => {} })
    server.onEvent((d) => seen.push(d))
    const body = '{"action":"opened","issue":{"number":7}}'
    expect(await post(server, body, hdrs(body, { event: 'issues' }))).toBe(200)
    await new Promise((r) => setTimeout(r, 20))
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ deliveryId: 'del-1', event: 'issues' })
    expect(seen[0].payload).toEqual({ action: 'opened', issue: { number: 7 } })
  })

  it('rejects a forged signature with 401 and never emits', async () => {
    const seen: GitHubWebhookDelivery[] = []
    server = await startGitHubWebhookServer({ secret: SECRET, log: () => {} })
    server.onEvent((d) => seen.push(d))
    const body = '{"action":"opened"}'
    expect(await post(server, body, hdrs(body, { sig: 'sha256=deadbeef' }))).toBe(401)
    await new Promise((r) => setTimeout(r, 20))
    expect(seen).toHaveLength(0)
  })

  it('dedups a repeated X-GitHub-Delivery with 200 and no second emit', async () => {
    const seen: GitHubWebhookDelivery[] = []
    server = await startGitHubWebhookServer({ secret: SECRET, log: () => {} })
    server.onEvent((d) => seen.push(d))
    const body = '{"action":"opened"}'
    expect(await post(server, body, hdrs(body, { id: 'dupe', event: 'issues' }))).toBe(200)
    expect(await post(server, body, hdrs(body, { id: 'dupe', event: 'issues' }))).toBe(200)
    await new Promise((r) => setTimeout(r, 20))
    expect(seen).toHaveLength(1)
  })

  it('rejects malformed JSON and a missing event header with 400/no emit', async () => {
    const seen: GitHubWebhookDelivery[] = []
    server = await startGitHubWebhookServer({ secret: SECRET, log: () => {} })
    server.onEvent((d) => seen.push(d))
    expect(await post(server, 'not json', hdrs('not json', { id: 'bad' }))).toBe(400)
    const body = '{"action":"opened"}'
    const noEvent = {
      'content-type': 'application/json',
      'x-hub-signature-256': sign(body),
      'x-github-delivery': 'no-evt'
    }
    expect(await post(server, body, noEvent)).toBe(400)
    await new Promise((r) => setTimeout(r, 20))
    expect(seen).toHaveLength(0)
  })

  it('never logs the secret or the raw body', async () => {
    const logs: string[] = []
    server = await startGitHubWebhookServer({ secret: SECRET, log: (m) => logs.push(m) })
    const body = '{"action":"opened","token":"ghp_leakcheck"}'
    await post(server, body, hdrs(body, { sig: 'sha256=bad', id: 'leak' }))
    await new Promise((r) => setTimeout(r, 20))
    for (const line of logs) {
      expect(line).not.toContain(SECRET)
      expect(line).not.toContain('ghp_leakcheck')
    }
  })
})
