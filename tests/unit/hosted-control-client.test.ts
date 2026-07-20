import { describe, it, expect } from 'vitest'
import {
  MockControlApi,
  HttpControlApi,
  type IngressUrl
} from '../../src/main/hosted/hosted-control-client'

describe('MockControlApi', () => {
  it('provision → list round-trips the new ingress URL', async () => {
    const api = new MockControlApi()
    expect(await api.listIngressUrls()).toEqual([])
    const provisioned = await api.provisionIngressUrl('shopify')
    expect(provisioned.integration).toBe('shopify')
    expect(provisioned.id).toMatch(/.+/)
    expect(provisioned.url).toMatch(/^https:\/\//)
    const listed = await api.listIngressUrls()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toEqual(provisioned)
  })

  it('seeds from canned URLs and mints a scoped drain token with a subscription', async () => {
    const seed: IngressUrl[] = [
      {
        id: 'url_seed',
        integration: 'hubspot',
        url: 'https://relay.example.com/t/abc/hubspot',
        createdAt: '2026-07-20T00:00:00Z'
      }
    ]
    const api = new MockControlApi({ ingressUrls: seed })
    expect(await api.listIngressUrls()).toEqual(seed)
    const token = await api.mintDrainToken()
    expect(token.token).toMatch(/.+/)
    expect(token.subscription).toMatch(/.+/)
    expect(token.expiresAt).toMatch(/.+/)
  })

  it('never surfaces a token value through any log callback', async () => {
    const logs: string[] = []
    const api = new MockControlApi({ log: (m) => logs.push(m) })
    const token = await api.mintDrainToken()
    await api.provisionIngressUrl('stripe')
    const joined = logs.join('\n')
    expect(joined).not.toContain(token.token)
  })
})

describe('HttpControlApi (deferred live client)', () => {
  const api = new HttpControlApi({
    baseUrl: 'https://relay.example.com',
    accountToken: () => 'account-token'
  })

  it('rejects every method with a legible "not wired yet" error', async () => {
    await expect(api.listIngressUrls()).rejects.toThrow(/not wired yet/i)
    await expect(api.provisionIngressUrl('shopify')).rejects.toThrow(/not wired yet/i)
    await expect(api.mintDrainToken()).rejects.toThrow(/not wired yet/i)
  })

  it('never reveals the account token in the deferred error', async () => {
    await expect(api.mintDrainToken()).rejects.not.toThrow(/account-token/)
  })
})
