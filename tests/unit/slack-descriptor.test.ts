import { describe, it, expect } from 'vitest'
import { slackDescriptor } from '../../src/main/slack/slack-descriptor'
import { DESCRIPTOR_DEFS, descriptorDefs } from '../../src/main/integrations/descriptors'
import { INTEGRATION_IDS } from '../../src/shared/integrations'
import { SLACK_TRIGGER_IDS, SLACK_ACTION_IDS } from '../../src/shared/slack'

describe('slack descriptor', () => {
  it('is registered in the shared union and DESCRIPTOR_DEFS', () => {
    expect([...INTEGRATION_IDS]).toContain('slack')
    expect(DESCRIPTOR_DEFS.slack).toBe(slackDescriptor)
    expect(descriptorDefs.map((d) => d.id)).toContain('slack')
  })

  it('pins the exact secret fields (§5) — three tokens, keychain only', () => {
    const secretKeys = slackDescriptor.configFields.filter((f) => f.secret).map((f) => f.key)
    expect(secretKeys).toEqual(['botToken', 'appToken', 'signingSecret'])
  })

  it('pins the statically-required fields (§5); mode-conditional secrets stay optional', () => {
    const requiredKeys = slackDescriptor.configFields.filter((f) => f.required).map((f) => f.key)
    // appToken / signingSecret are conditionally required by `mode` (§13.6), so
    // they are NOT statically required — a thin Slack check owns that.
    expect(requiredKeys).toEqual(['botToken', 'defaultChannel', 'environment'])
  })

  it('gives every field a valid FieldType', () => {
    for (const f of slackDescriptor.configFields) {
      expect(['string', 'string[]', 'number']).toContain(f.type)
    }
  })

  it('pins the trigger ids the templates track consumes (§6.1)', () => {
    expect(slackDescriptor.triggers.map((t) => t.id)).toEqual([
      'message.received',
      'slash.command',
      'approval.responded'
    ])
    expect(slackDescriptor.triggers.map((t) => t.id)).toEqual([...SLACK_TRIGGER_IDS])
  })

  it('pins the action ids (§6.2)', () => {
    expect(slackDescriptor.actions.map((a) => a.id)).toEqual([...SLACK_ACTION_IDS])
    expect(slackDescriptor.actions.map((a) => a.id)).toEqual([
      'postMessage',
      'postApproval',
      'replyInThread'
    ])
  })

  it('never places a secret VALUE in the static descriptor (only placeholders)', () => {
    const serialized = JSON.stringify(slackDescriptor)
    expect(serialized).not.toContain('xoxb-real')
    expect(serialized).not.toContain('xapp-real')
  })
})
