import { describe, it, expect } from 'vitest'
import {
  DiscordRestApi,
  MockDiscordApi,
  CALLBACK_UPDATE_MESSAGE,
  type DiscordHttpResult,
  type DiscordHttpTransport
} from '../../src/main/discord/discord-client'

const ok = (body: Record<string, unknown>, status = 200): DiscordHttpResult => ({ status, body })
const fail = (status: number, message = 'nope'): DiscordHttpResult => ({
  status,
  body: { code: status, message }
})

describe('DiscordRestApi', () => {
  it('postMessage forwards params and returns the channel+message ref', async () => {
    const seen: unknown[] = []
    const transport: DiscordHttpTransport = async (req) => {
      seen.push(req)
      return ok({ id: '55', channel_id: 'C1' })
    }
    const api = new DiscordRestApi({ transport })
    const ref = await api.postMessage({ channelId: 'C1', body: { content: 'hi' } })
    expect(ref).toEqual({ channelId: 'C1', messageId: '55' })
    expect(seen[0]).toEqual({
      method: 'postMessage',
      params: { channelId: 'C1', body: { content: 'hi' } }
    })
  })

  it('respondToInteraction forwards the callback type + body', async () => {
    const seen: unknown[] = []
    const transport: DiscordHttpTransport = async (req) => {
      seen.push(req)
      return ok({})
    }
    const api = new DiscordRestApi({ transport })
    await api.respondToInteraction({
      interactionId: 'i1',
      token: 't1',
      type: CALLBACK_UPDATE_MESSAGE,
      body: { content: 'Approved', components: [] }
    })
    expect(seen[0]).toEqual({
      method: 'respondToInteraction',
      params: {
        interactionId: 'i1',
        token: 't1',
        type: 7,
        body: { content: 'Approved', components: [] }
      }
    })
  })

  it('getGatewayUrl returns the Gateway WS url', async () => {
    const api = new DiscordRestApi({ transport: async () => ok({ url: 'wss://gw/socket' }) })
    expect(await api.getGatewayUrl()).toEqual({ url: 'wss://gw/socket' })
  })

  it('rejects with a legible token error (never the token) on 401', async () => {
    const api = new DiscordRestApi({ transport: async () => fail(401) })
    await expect(api.postMessage({ channelId: 'C1', body: { content: 'x' } })).rejects.toThrow(
      /Discord rejected the bot token \(401\)/
    )
  })

  it('rejects legibly on 403 Missing Access and 404', async () => {
    const a = new DiscordRestApi({ transport: async () => fail(403, 'Missing Access') })
    await expect(a.postMessage({ channelId: 'C1', body: { content: 'x' } })).rejects.toThrow(
      /403 Missing Access/
    )
    const b = new DiscordRestApi({ transport: async () => fail(404, 'Unknown Channel') })
    await expect(b.postMessage({ channelId: 'C1', body: { content: 'x' } })).rejects.toThrow(/404/)
  })

  it('retries a 429 honoring retry_after, then succeeds', async () => {
    let calls = 0
    const slept: number[] = []
    const transport: DiscordHttpTransport = async () => {
      calls++
      if (calls < 3) return { status: 429, retryAfter: 2, body: {} }
      return ok({ id: '9', channel_id: 'C1' })
    }
    const api = new DiscordRestApi({ transport, sleep: async (ms) => void slept.push(ms) })
    const ref = await api.postMessage({ channelId: 'C1', body: { content: 'x' } })
    expect(ref.messageId).toBe('9')
    expect(calls).toBe(3)
    expect(slept).toEqual([2000, 2000])
  })

  it('rejects after exhausting 429 retries — never swallowed', async () => {
    const api = new DiscordRestApi({
      transport: async () => ({ status: 429, retryAfter: 5, body: {} }),
      sleep: async () => {}
    })
    await expect(api.postMessage({ channelId: 'C1', body: { content: 'x' } })).rejects.toThrow(
      /throttled.*retry in ~5s/
    )
  })
})

describe('MockDiscordApi', () => {
  it('records calls and returns a synthetic ref', async () => {
    const api = new MockDiscordApi()
    const ref = await api.postMessage({ channelId: 'C9', body: { content: 'yo' } })
    expect(ref.channelId).toBe('C9')
    expect(api.calls.postMessage).toHaveLength(1)
  })

  it('can be scripted to reject with an HTTP status', async () => {
    const api = new MockDiscordApi({ postStatus: 403 })
    await expect(api.postMessage({ channelId: 'C9', body: { content: 'yo' } })).rejects.toThrow(
      /403/
    )
  })
})
