import { describe, it, expect } from 'vitest'
import { parseHostedConfig } from '../../src/main/hosted/hosted-config'

describe('parseHostedConfig — validate at the boundary', () => {
  it('accepts a well-formed enabled block with an https control-API base URL', () => {
    const out = parseHostedConfig({
      enabled: true,
      controlApiBaseUrl: 'https://relay.example.com'
    })
    expect(out).toEqual({ enabled: true, controlApiBaseUrl: 'https://relay.example.com' })
  })

  it('defaults enabled to false (opt-in) when absent or not true → never drains', () => {
    const a = parseHostedConfig({ controlApiBaseUrl: 'https://relay.example.com' })
    expect(a).toMatchObject({ enabled: false })
    const b = parseHostedConfig({ enabled: 'yes', controlApiBaseUrl: 'https://relay.example.com' })
    expect(b).toMatchObject({ enabled: false })
  })

  it('rejects a non-https base URL with a legible error (no plaintext relay)', () => {
    const out = parseHostedConfig({ enabled: true, controlApiBaseUrl: 'http://relay.example.com' })
    expect(out).toHaveProperty('error')
    expect((out as { error: string }).error).toMatch(/https/i)
  })

  it('rejects a missing/garbage base URL and a non-object block', () => {
    expect(parseHostedConfig({ enabled: true })).toHaveProperty('error')
    expect(parseHostedConfig({ enabled: true, controlApiBaseUrl: 'not a url' })).toHaveProperty(
      'error'
    )
    expect(parseHostedConfig(null)).toHaveProperty('error')
    expect(parseHostedConfig('nope')).toHaveProperty('error')
  })

  it('drops a hand-edited account token in config.json and notifies legibly', () => {
    const notices: string[] = []
    const out = parseHostedConfig(
      {
        enabled: true,
        controlApiBaseUrl: 'https://relay.example.com',
        accountToken: 'leaked-token-in-config'
      },
      (m) => notices.push(m)
    )
    // The parsed config carries no token field; the notice is legible.
    expect(JSON.stringify(out)).not.toContain('leaked-token-in-config')
    expect(notices.join('\n')).toMatch(/config\.json/i)
    expect(notices.join('\n')).toMatch(/keychain|Settings/i)
  })

  it('keeps only well-formed cached ingress URLs and drops garbage', () => {
    const out = parseHostedConfig({
      enabled: true,
      controlApiBaseUrl: 'https://relay.example.com',
      ingressUrls: [
        {
          id: 'url_1',
          integration: 'shopify',
          url: 'https://relay.example.com/t/abc/shopify',
          createdAt: '2026-07-20T00:00:00Z'
        },
        { id: 'bad' }, // missing fields → dropped
        { id: 'url_2', integration: 'not-an-integration', url: 'x', createdAt: 'y' } // bad id → dropped
      ]
    })
    expect(out).not.toHaveProperty('error')
    const config = out as { ingressUrls?: unknown[] }
    expect(config.ingressUrls).toHaveLength(1)
    expect(config.ingressUrls?.[0]).toMatchObject({ id: 'url_1', integration: 'shopify' })
  })
})
