import { describe, it, expect } from 'vitest'
import { zendeskDescriptor } from '../../src/main/zendesk/zendesk-descriptor'
import { DESCRIPTOR_DEFS, descriptorDefs } from '../../src/main/integrations/descriptors'
import { INTEGRATION_IDS } from '../../src/shared/integrations'
import {
  ZENDESK_TRIGGER_IDS,
  ZENDESK_READ_ACTION_IDS,
  ZENDESK_MUTATION_ACTION_IDS,
  ZENDESK_PUBLIC_REPLY_ACTION_ID
} from '../../src/shared/zendesk'

describe('zendesk descriptor', () => {
  it('is registered in the shared union and DESCRIPTOR_DEFS (lockstep, §6.0)', () => {
    expect([...INTEGRATION_IDS]).toContain('zendesk')
    expect(DESCRIPTOR_DEFS.zendesk).toBe(zendeskDescriptor)
    expect(descriptorDefs.map((d) => d.id)).toContain('zendesk')
  })

  it('pins the exact secret fields (§5) — API token + webhook secret, keychain only', () => {
    const secretKeys = zendeskDescriptor.configFields.filter((f) => f.secret).map((f) => f.key)
    expect(secretKeys).toEqual(['apiToken', 'webhookSecret'])
  })

  it('pins the exact required fields (§5)', () => {
    const requiredKeys = zendeskDescriptor.configFields.filter((f) => f.required).map((f) => f.key)
    expect(requiredKeys).toEqual([
      'apiToken',
      'webhookSecret',
      'subdomain',
      'agentEmail',
      'environment'
    ])
  })

  it('carries subdomain + agentEmail as NON-secret refs (§8 — the token half is the secret)', () => {
    const subdomain = zendeskDescriptor.configFields.find((f) => f.key === 'subdomain')
    const agentEmail = zendeskDescriptor.configFields.find((f) => f.key === 'agentEmail')
    expect(subdomain).toMatchObject({ secret: false, placeholder: 'your-co' })
    expect(agentEmail?.secret).toBe(false)
  })

  it('gives every field a valid FieldType', () => {
    for (const f of zendeskDescriptor.configFields) {
      expect(['string', 'string[]', 'number']).toContain(f.type)
    }
  })

  it('pins the four trigger ids the templates track consumes (§6.1)', () => {
    expect(zendeskDescriptor.triggers.map((t) => t.id)).toEqual([
      'ticket.commentAdded',
      'ticket.created',
      'ticket.updated',
      'ticket.escalated'
    ])
    expect(zendeskDescriptor.triggers.map((t) => t.id)).toEqual([...ZENDESK_TRIGGER_IDS])
  })

  it('pins the read + gated-mutation action ids (§6.2)', () => {
    expect(zendeskDescriptor.actions.map((a) => a.id)).toEqual([
      ...ZENDESK_READ_ACTION_IDS,
      ...ZENDESK_MUTATION_ACTION_IDS
    ])
    // The five support mutations, with the public reply first (the only never-auto-send id).
    expect([...ZENDESK_MUTATION_ACTION_IDS]).toEqual([
      'replyToTicket',
      'addInternalNote',
      'setStatus',
      'assignTicket',
      'tagTicket'
    ])
    expect(ZENDESK_PUBLIC_REPLY_ACTION_ID).toBe('replyToTicket')
  })
})
