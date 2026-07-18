import { describe, it, expect } from 'vitest'
import { parseSlackConfig, normalizeMode } from '../../src/main/slack/slack-config'

describe('parseSlackConfig', () => {
  it('returns null when required non-secret refs are absent (opt-in dormancy)', () => {
    expect(parseSlackConfig(undefined)).toBeNull()
    expect(parseSlackConfig({ enabled: true, values: {} })).toBeNull()
    expect(
      parseSlackConfig({ enabled: true, values: { defaultChannel: 'C1' } })
    ).toBeNull()
  })

  it('defaults mode to socket (the zero-ingress path) when unset', () => {
    const cfg = parseSlackConfig({
      enabled: true,
      values: { defaultChannel: 'C0123', environment: 2 }
    })
    expect(cfg).toEqual({ defaultChannel: 'C0123', mode: 'socket', environment: 2 })
  })

  it('carries the events url + mode when configured for the Events path', () => {
    const cfg = parseSlackConfig({
      enabled: true,
      values: {
        defaultChannel: '#approvals',
        environment: 1,
        mode: 'events',
        eventsUrl: 'https://x.tunnel/slack/events'
      }
    })
    expect(cfg).toEqual({
      defaultChannel: '#approvals',
      mode: 'events',
      environment: 1,
      eventsUrl: 'https://x.tunnel/slack/events'
    })
  })

  it('normalizeMode coerces unknown values to socket', () => {
    expect(normalizeMode('events')).toBe('events')
    expect(normalizeMode('socket')).toBe('socket')
    expect(normalizeMode('nonsense')).toBe('socket')
    expect(normalizeMode(undefined)).toBe('socket')
  })
})
