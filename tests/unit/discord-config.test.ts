import { describe, it, expect } from 'vitest'
import { parseDiscordConfig, normalizeMode } from '../../src/main/discord/discord-config'

describe('parseDiscordConfig', () => {
  it('returns null when required non-secret refs are absent (opt-in dormancy)', () => {
    expect(parseDiscordConfig(undefined)).toBeNull()
    expect(parseDiscordConfig({ enabled: true, values: {} })).toBeNull()
    expect(parseDiscordConfig({ enabled: true, values: { guildId: 'G1' } })).toBeNull()
    expect(
      parseDiscordConfig({ enabled: true, values: { guildId: 'G1', defaultChannel: 'C1' } })
    ).toBeNull()
  })

  it('defaults mode to gateway (the zero-ingress path) when unset', () => {
    const cfg = parseDiscordConfig({
      enabled: true,
      values: { guildId: 'G1', defaultChannel: 'C0123', environment: 2 }
    })
    expect(cfg).toEqual({
      guildId: 'G1',
      defaultChannel: 'C0123',
      mode: 'gateway',
      environment: 2
    })
  })

  it('carries the http mode + public key + interactions url when configured', () => {
    const cfg = parseDiscordConfig({
      enabled: true,
      values: {
        guildId: 'G1',
        defaultChannel: 'C1',
        environment: 1,
        mode: 'http',
        applicationId: 'A1',
        publicKey: 'pub-ed25519',
        interactionsUrl: 'https://x.tunnel/discord/interactions'
      }
    })
    expect(cfg).toEqual({
      guildId: 'G1',
      defaultChannel: 'C1',
      mode: 'http',
      environment: 1,
      applicationId: 'A1',
      publicKey: 'pub-ed25519',
      interactionsUrl: 'https://x.tunnel/discord/interactions'
    })
  })

  it('normalizeMode coerces unknown values to gateway', () => {
    expect(normalizeMode('http')).toBe('http')
    expect(normalizeMode('gateway')).toBe('gateway')
    expect(normalizeMode('nonsense')).toBe('gateway')
    expect(normalizeMode(undefined)).toBe('gateway')
  })
})
