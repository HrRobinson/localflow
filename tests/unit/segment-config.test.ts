import { describe, it, expect } from 'vitest'
import {
  DEFAULT_DATA_PLANE_URL,
  DEFAULT_WEBHOOK_PATH,
  parseSegmentConfig
} from '../../src/main/segment/segment-config'
import type { IntegrationConfigEntry } from '../../src/shared/integrations'

/**
 * Validate-at-the-boundary (spec §5, §4.4). The `writeKey` is sent to
 * `${dataPlaneUrl}/v1/…` once the live transport lands, so an arbitrary
 * `dataPlaneUrl` is an SSRF hole: `http://169.254.169.254` (cloud metadata),
 * loopback, RFC-1918, and plain-http public hosts must never reach the write
 * path. A failing URL is coerced to the trusted US default so the write can only
 * ever target Segment — matching how this file drops other invalid values.
 */

const entry = (dataPlaneUrl?: string): IntegrationConfigEntry => ({
  enabled: true,
  values: dataPlaneUrl === undefined ? { environment: 1 } : { environment: 1, dataPlaneUrl }
})

describe('parseSegmentConfig — dataPlaneUrl SSRF guard (§4.4)', () => {
  it('defaults to the US data-plane and webhook path when unset', () => {
    const cfg = parseSegmentConfig(entry())
    expect(cfg?.dataPlaneUrl).toBe(DEFAULT_DATA_PLANE_URL)
    expect(cfg?.webhookPath).toBe(DEFAULT_WEBHOOK_PATH)
  })

  it('accepts a legitimate https public data-plane (US / EU) and trims a trailing slash', () => {
    expect(parseSegmentConfig(entry('https://api.segment.io'))?.dataPlaneUrl).toBe(
      'https://api.segment.io'
    )
    expect(parseSegmentConfig(entry('https://events.eu1.segmentapis.com/'))?.dataPlaneUrl).toBe(
      'https://events.eu1.segmentapis.com'
    )
  })

  it('coerces every SSRF / non-https target back to the safe default', () => {
    // The write path can NEVER be pointed at any of these.
    for (const bad of [
      'http://169.254.169.254',
      'https://169.254.169.254',
      'http://localhost',
      'https://localhost',
      'http://10.0.0.1',
      'https://192.168.1.1',
      'http://api.segment.io', // plain-http public host — auth in the clear
      'file:///etc/passwd',
      'not a url'
    ]) {
      const cfg = parseSegmentConfig(entry(bad))
      expect(cfg, `should not be null for ${bad}`).not.toBeNull()
      expect(cfg?.dataPlaneUrl, `write path must not target ${bad}`).toBe(DEFAULT_DATA_PLANE_URL)
    }
  })

  it('stays dormant (null) only when the required environment is absent', () => {
    expect(parseSegmentConfig(undefined)).toBeNull()
    expect(parseSegmentConfig({ enabled: true, values: {} })).toBeNull()
  })
})
