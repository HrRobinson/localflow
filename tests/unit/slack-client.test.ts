import { describe, it, expect } from 'vitest'
import {
  SlackWebApi,
  MockSlackApi,
  type SlackHttpResult,
  type SlackHttpTransport
} from '../../src/main/slack/slack-client'

const ok = (body: Record<string, unknown>): SlackHttpResult => ({
  status: 200,
  body: { ok: true, ...body }
})
const fail = (error: string, extra: Record<string, unknown> = {}): SlackHttpResult => ({
  status: 200,
  body: { ok: false, error, ...extra }
})

describe('SlackWebApi', () => {
  it('postMessage forwards params and returns the channel+ts ref', async () => {
    const seen: unknown[] = []
    const transport: SlackHttpTransport = async (req) => {
      seen.push(req)
      return ok({ channel: req.params.channel, ts: '1700.0001' })
    }
    const api = new SlackWebApi({ transport })
    const ref = await api.postMessage({
      channel: 'C1',
      text: 'hi',
      blocks: [{ x: 1 }],
      threadTs: '99.9'
    })
    expect(ref).toEqual({ channel: 'C1', ts: '1700.0001' })
    expect(seen[0]).toEqual({
      method: 'chat.postMessage',
      params: { channel: 'C1', text: 'hi', blocks: [{ x: 1 }], thread_ts: '99.9' }
    })
  })

  it('openConnection returns the Socket Mode WS url', async () => {
    const transport: SlackHttpTransport = async () => ok({ url: 'wss://x/socket' })
    const api = new SlackWebApi({ transport })
    expect(await api.openConnection()).toEqual({ url: 'wss://x/socket' })
  })

  it('rejects with a legible token error (never the token value) on invalid_auth', async () => {
    const transport: SlackHttpTransport = async () => fail('invalid_auth')
    const api = new SlackWebApi({ transport })
    await expect(api.postMessage({ channel: 'C1', text: 'x' })).rejects.toThrow(
      /Slack rejected the bot token \(`invalid_auth`\)/
    )
  })

  it('rejects with the verbatim missing scope', async () => {
    const transport: SlackHttpTransport = async () =>
      fail('missing_scope', { needed: 'chat:write' })
    const api = new SlackWebApi({ transport })
    await expect(api.postMessage({ channel: 'C1', text: 'x' })).rejects.toThrow(
      /`chat:write` scope/
    )
  })

  it('rejects legibly when the bot is not in the channel', async () => {
    const transport: SlackHttpTransport = async () => fail('not_in_channel')
    const api = new SlackWebApi({ transport })
    await expect(api.postMessage({ channel: 'C1', text: 'x' })).rejects.toThrow(/isn't a member/)
  })

  it('retries a 429 honoring Retry-After, then succeeds', async () => {
    let calls = 0
    const slept: number[] = []
    const transport: SlackHttpTransport = async () => {
      calls++
      if (calls < 3)
        return { status: 429, retryAfter: 2, body: { ok: false, error: 'ratelimited' } }
      return ok({ channel: 'C1', ts: '1.1' })
    }
    const api = new SlackWebApi({ transport, sleep: async (ms) => void slept.push(ms) })
    const ref = await api.postMessage({ channel: 'C1', text: 'x' })
    expect(ref.ts).toBe('1.1')
    expect(calls).toBe(3)
    expect(slept).toEqual([2000, 2000])
  })

  it('rejects after exhausting 429 retries — never swallowed', async () => {
    const transport: SlackHttpTransport = async () => ({
      status: 429,
      retryAfter: 5,
      body: { ok: false, error: 'ratelimited' }
    })
    const api = new SlackWebApi({ transport, sleep: async () => {} })
    await expect(api.postMessage({ channel: 'C1', text: 'x' })).rejects.toThrow(
      /throttled.*retry in ~5s/
    )
  })
})

describe('MockSlackApi', () => {
  it('records calls and returns a synthetic ref', async () => {
    const api = new MockSlackApi()
    const ref = await api.postMessage({ channel: 'C9', text: 'yo' })
    expect(ref.channel).toBe('C9')
    expect(api.calls.postMessage).toHaveLength(1)
  })

  it('can be scripted to reject with a Slack error code', async () => {
    const api = new MockSlackApi({ postError: 'channel_not_found' })
    await expect(api.postMessage({ channel: 'C9', text: 'yo' })).rejects.toThrow(
      /channel_not_found/
    )
  })
})
