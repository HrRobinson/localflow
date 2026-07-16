import { describe, it, expect } from 'vitest'
import { parseLinearConfig } from '../../src/main/linear/linear-config'

const valid = {
  linear: {
    enabled: true,
    workspaceId: 'org-123',
    environment: 1,
    agentId: 'claude',
    webhookUrl: 'https://tunnel.example/linear/webhook'
  }
}

describe('parseLinearConfig', () => {
  it('parses a well-typed, enabled block', () => {
    expect(parseLinearConfig(valid)).toEqual({
      enabled: true,
      workspaceId: 'org-123',
      environment: 1,
      agentId: 'claude',
      webhookUrl: 'https://tunnel.example/linear/webhook'
    })
  })

  it('honors the optional moveToStateOnDone and teamIds', () => {
    const cfg = parseLinearConfig({
      linear: { ...valid.linear, moveToStateOnDone: 'state-done', teamIds: ['t1', 't2'] }
    })
    expect(cfg?.moveToStateOnDone).toBe('state-done')
    expect(cfg?.teamIds).toEqual(['t1', 't2'])
  })

  it('drops garbage optional fields but keeps the feature enabled', () => {
    const cfg = parseLinearConfig({
      linear: { ...valid.linear, moveToStateOnDone: 42, teamIds: ['ok', 7] }
    })
    expect(cfg).not.toBeNull()
    expect(cfg?.moveToStateOnDone).toBeUndefined()
    expect(cfg?.teamIds).toBeUndefined()
  })

  it('disables (null) when absent, disabled, or not an object', () => {
    expect(parseLinearConfig({})).toBeNull()
    expect(parseLinearConfig(null)).toBeNull()
    expect(parseLinearConfig([1, 2])).toBeNull()
    expect(parseLinearConfig({ linear: null })).toBeNull()
    expect(parseLinearConfig({ linear: { ...valid.linear, enabled: false } })).toBeNull()
    expect(parseLinearConfig({ linear: { ...valid.linear, enabled: 'true' } })).toBeNull()
  })

  it('disables when a required reference is missing or malformed', () => {
    expect(parseLinearConfig({ linear: { ...valid.linear, workspaceId: '' } })).toBeNull()
    expect(parseLinearConfig({ linear: { ...valid.linear, workspaceId: 5 } })).toBeNull()
  })

  it('disables when the environment is out of the 1-9 range', () => {
    expect(parseLinearConfig({ linear: { ...valid.linear, environment: 0 } })).toBeNull()
    expect(parseLinearConfig({ linear: { ...valid.linear, environment: 10 } })).toBeNull()
    expect(parseLinearConfig({ linear: { ...valid.linear, environment: 1.5 } })).toBeNull()
  })

  it('disables when the agentId is outside the operator terminal agents', () => {
    // A capability boundary, not a shape check (mirrors control-api): 'shell'
    // and 'openclaw' are excluded, so a Linear-driven pane can never be one.
    expect(parseLinearConfig({ linear: { ...valid.linear, agentId: 'shell' } })).toBeNull()
    expect(parseLinearConfig({ linear: { ...valid.linear, agentId: 'openclaw' } })).toBeNull()
    expect(parseLinearConfig({ linear: { ...valid.linear, agentId: 'nope' } })).toBeNull()
  })

  it('disables when the webhookUrl is not a valid https URL', () => {
    expect(parseLinearConfig({ linear: { ...valid.linear, webhookUrl: 'not a url' } })).toBeNull()
    expect(
      parseLinearConfig({ linear: { ...valid.linear, webhookUrl: 'http://insecure/webhook' } })
    ).toBeNull()
  })
})
