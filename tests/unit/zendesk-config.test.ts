import { describe, it, expect } from 'vitest'
import { normalizeSubdomain, parseZendeskConfig } from '../../src/main/zendesk/zendesk-config'
import type { IntegrationConfigEntry } from '../../src/shared/integrations'

/**
 * Validate-at-the-boundary (spec §5, §4.2). The subdomain is interpolated into
 * `https://{subdomain}.zendesk.com/…`, so a non-DNS-label result is HOST
 * CONFUSION (SSRF): `attacker.example.com#` would make the Basic-auth API token
 * land at the attacker's host. The normalizer strips a pasted URL, and the parse
 * step REJECTS anything that isn't a single DNS label (connector stays dormant —
 * the opt-in posture), rather than leaking the token.
 */

const entry = (subdomain: string): IntegrationConfigEntry => ({
  enabled: true,
  values: { subdomain, agentEmail: 'agent@acme.com', environment: 1 }
})

describe('normalizeSubdomain — reduce a pasted ref to the bare tenant label', () => {
  it('accepts a bare label, mixed case, a full URL, and a URL with a path', () => {
    expect(normalizeSubdomain('mycompany')).toBe('mycompany')
    expect(normalizeSubdomain('MyCompany')).toBe('mycompany')
    expect(normalizeSubdomain('https://mycompany.zendesk.com')).toBe('mycompany')
    expect(normalizeSubdomain('mycompany.zendesk.com/agent/tickets/1')).toBe('mycompany')
    expect(normalizeSubdomain('HTTPS://MyCompany.ZenDesk.com/agent')).toBe('mycompany')
  })
})

describe('parseZendeskConfig — DNS-label host-confusion guard (SSRF, §4.2)', () => {
  it('carries a valid normalized subdomain through, with the agent email', () => {
    expect(parseZendeskConfig(entry('MyCompany'))).toMatchObject({
      subdomain: 'mycompany',
      agentEmail: 'agent@acme.com',
      environment: 1
    })
    expect(parseZendeskConfig(entry('https://mycompany.zendesk.com/agent'))?.subdomain).toBe(
      'mycompany'
    )
    // A hyphenated label is a legal DNS label and survives.
    expect(parseZendeskConfig(entry('my-co-123'))?.subdomain).toBe('my-co-123')
  })

  it('REJECTS (null) any subdomain that is not a single DNS label', () => {
    // The canonical host-confusion payload: a `#` fragment that would make
    // `new URL('https://attacker.example.com#.zendesk.com/…').host` the attacker.
    expect(parseZendeskConfig(entry('attacker.example.com#'))).toBeNull()
    expect(parseZendeskConfig(entry('foo/bar'))).toBeNull()
    expect(parseZendeskConfig(entry('foo bar'))).toBeNull()
    expect(parseZendeskConfig(entry('foo..bar'))).toBeNull()
    expect(parseZendeskConfig(entry(''))).toBeNull()
    expect(parseZendeskConfig(entry('a@b'))).toBeNull()
    // A dotted host that isn't a zendesk.com URL is not a single label either.
    expect(parseZendeskConfig(entry('attacker.example.com'))).toBeNull()
  })

  it('stays dormant (null) when a required non-secret ref is absent', () => {
    expect(parseZendeskConfig(undefined)).toBeNull()
    expect(parseZendeskConfig({ enabled: true, values: { environment: 1 } })).toBeNull()
    expect(
      parseZendeskConfig({ enabled: true, values: { subdomain: 'ok', agentEmail: 'a@b.com' } })
    ).toBeNull()
  })
})
