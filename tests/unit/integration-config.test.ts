import { describe, it, expect } from 'vitest'
import { parseIntegrationsConfig } from '../../src/main/integrations/integration-config'

describe('parseIntegrationsConfig', () => {
  it('returns {} for a non-object top level', () => {
    expect(parseIntegrationsConfig(null)).toEqual({})
    expect(parseIntegrationsConfig([1, 2])).toEqual({})
    expect(parseIntegrationsConfig('nope')).toEqual({})
    expect(parseIntegrationsConfig({})).toEqual({})
  })

  it('drops unknown integration ids', () => {
    const cfg = parseIntegrationsConfig({ integrations: { notion: { enabled: true } } })
    expect(cfg).toEqual({})
  })

  it('honors enabled only on a literal true', () => {
    const cfg = parseIntegrationsConfig({
      integrations: { linear: { enabled: 'true', workspaceId: 'ws' } }
    })
    expect(cfg.linear?.enabled).toBe(false)
    const on = parseIntegrationsConfig({ integrations: { linear: { enabled: true } } })
    expect(on.linear?.enabled).toBe(true)
  })

  it('type-checks and trims non-secret fields, dropping wrong types', () => {
    const cfg = parseIntegrationsConfig({
      integrations: {
        linear: {
          enabled: true,
          workspaceId: '  ws-1  ',
          teamIds: ['  t1 ', 't2', 42],
          webhookUrl: 123
        }
      }
    })
    expect(cfg.linear?.values.workspaceId).toBe('ws-1')
    expect(cfg.linear?.values.teamIds).toEqual(['t1', 't2']) // non-string element dropped
    expect(cfg.linear?.values.webhookUrl).toBeUndefined() // wrong type dropped
  })

  it('accepts environment only as an integer in 1..9', () => {
    const ok = parseIntegrationsConfig({ integrations: { linear: { environment: 3 } } })
    expect(ok.linear?.values.environment).toBe(3)
    for (const bad of [0, 10, 3.5, '3']) {
      const cfg = parseIntegrationsConfig({ integrations: { linear: { environment: bad } } })
      expect(cfg.linear?.values.environment).toBeUndefined()
    }
  })

  it('clamps durationSeconds to the ≤1800 cap', () => {
    const cfg = parseIntegrationsConfig({ integrations: { cloud: { durationSeconds: 5000 } } })
    expect(cfg.cloud?.values.durationSeconds).toBe(1800)
    const ok = parseIntegrationsConfig({ integrations: { cloud: { durationSeconds: 900 } } })
    expect(ok.cloud?.values.durationSeconds).toBe(900)
  })

  it('drops a secret key found in config.json and emits a loud notice', () => {
    const notices: string[] = []
    const cfg = parseIntegrationsConfig(
      {
        integrations: { linear: { enabled: true, oauthToken: 'lin_live_LEAK', workspaceId: 'ws' } }
      },
      (m) => notices.push(m)
    )
    expect(cfg.linear?.values.oauthToken).toBeUndefined()
    expect(JSON.stringify(cfg)).not.toContain('lin_live_LEAK')
    expect(notices.some((n) => n.includes('linear.oauthToken') && /keychain/i.test(n))).toBe(true)
    // The notice itself must never carry the secret value.
    expect(notices.join('\n')).not.toContain('lin_live_LEAK')
  })

  it('keeps cloud (all-non-secret) values', () => {
    const cfg = parseIntegrationsConfig({
      integrations: {
        cloud: {
          enabled: true,
          roleArn: 'arn:aws:iam::1:role/x',
          externalId: 'ext',
          region: 'us-east-1'
        }
      }
    })
    expect(cfg.cloud?.values).toEqual({
      roleArn: 'arn:aws:iam::1:role/x',
      externalId: 'ext',
      region: 'us-east-1'
    })
  })
})
