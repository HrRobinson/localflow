import { describe, it, expect } from 'vitest'
import { parseSalesforceConfig } from '../../src/main/salesforce/salesforce-config'

/**
 * Validate-at-the-boundary (spec §5, §4.4): only well-typed values are honored;
 * garbage / a private-range login|instance URL DISABLES the feature (returns
 * null) rather than throwing. The SSRF guard runs HERE so a fat-fingered internal
 * URL never reaches a request.
 */

const base = {
  enabled: true,
  clientId: '3MVG9...consumerKey',
  loginUrl: 'https://login.salesforce.com',
  environment: 1
}

describe('parseSalesforceConfig', () => {
  it('accepts a well-formed block and carries the optional refs through', () => {
    const cfg = parseSalesforceConfig({
      salesforce: {
        ...base,
        instanceUrl: 'https://acme.my.salesforce.com',
        username: 'integration@acme.com',
        apiVersion: 'v62.0',
        defaultObject: 'Lead',
        pollSeconds: 120
      }
    })
    expect(cfg).toMatchObject({
      enabled: true,
      clientId: '3MVG9...consumerKey',
      loginUrl: 'https://login.salesforce.com',
      instanceUrl: 'https://acme.my.salesforce.com',
      username: 'integration@acme.com',
      apiVersion: 'v62.0',
      defaultObject: 'Lead',
      pollSeconds: 120,
      environment: 1
    })
  })

  it('disables (null) when disabled, or when a required ref is missing', () => {
    expect(parseSalesforceConfig({ salesforce: { ...base, enabled: false } })).toBeNull()
    expect(parseSalesforceConfig({ salesforce: { ...base, clientId: '' } })).toBeNull()
    expect(parseSalesforceConfig({ salesforce: { ...base, loginUrl: undefined } })).toBeNull()
    expect(parseSalesforceConfig({ salesforce: { ...base, environment: 0 } })).toBeNull()
    expect(parseSalesforceConfig({})).toBeNull()
  })

  // ── ★ SSRF-on-URL: the instance / login URL runs through the shared guard ────
  it('REFUSES a private/loopback/metadata login URL at the config boundary (SSRF, §4.4)', () => {
    expect(
      parseSalesforceConfig({ salesforce: { ...base, loginUrl: 'https://127.0.0.1/services' } })
    ).toBeNull()
    expect(
      parseSalesforceConfig({ salesforce: { ...base, loginUrl: 'https://10.0.0.5' } })
    ).toBeNull()
    expect(
      parseSalesforceConfig({ salesforce: { ...base, loginUrl: 'https://169.254.169.254' } })
    ).toBeNull()
    // Non-https is refused too (would send auth in the clear).
    expect(
      parseSalesforceConfig({ salesforce: { ...base, loginUrl: 'http://login.salesforce.com' } })
    ).toBeNull()
  })

  it('REFUSES a present-but-private instance URL, even with a valid login URL', () => {
    expect(
      parseSalesforceConfig({
        salesforce: { ...base, instanceUrl: 'https://192.168.1.10' }
      })
    ).toBeNull()
  })

  it('clamps an absurd pollSeconds and drops a non-positive one', () => {
    expect(
      parseSalesforceConfig({ salesforce: { ...base, pollSeconds: 999999 } })?.pollSeconds
    ).toBe(3600)
    expect(
      parseSalesforceConfig({ salesforce: { ...base, pollSeconds: -1 } })?.pollSeconds
    ).toBeUndefined()
  })
})
