import { describe, it, expect } from 'vitest'
import { discordDescriptor } from '../../src/main/discord/discord-descriptor'
import { DESCRIPTOR_DEFS, descriptorDefs } from '../../src/main/integrations/descriptors'
import { INTEGRATION_IDS } from '../../src/shared/integrations'
import { DISCORD_TRIGGER_IDS, DISCORD_ACTION_IDS } from '../../src/shared/discord'

describe('discord descriptor', () => {
  it('is registered in the shared union and DESCRIPTOR_DEFS', () => {
    expect([...INTEGRATION_IDS]).toContain('discord')
    expect(DESCRIPTOR_DEFS.discord).toBe(discordDescriptor)
    expect(descriptorDefs.map((d) => d.id)).toContain('discord')
  })

  it('pins the ONE secret field (§5) — the bot token, keychain only', () => {
    const secretKeys = discordDescriptor.configFields.filter((f) => f.secret).map((f) => f.key)
    expect(secretKeys).toEqual(['botToken'])
  })

  it('pins the statically-required fields (§5); the public key stays optional (http-conditional)', () => {
    const requiredKeys = discordDescriptor.configFields.filter((f) => f.required).map((f) => f.key)
    expect(requiredKeys).toEqual(['botToken', 'guildId', 'defaultChannel', 'environment'])
  })

  it('keeps the (public) Ed25519 key NON-secret — it lives in config, not the keychain', () => {
    const publicKey = discordDescriptor.configFields.find((f) => f.key === 'publicKey')
    expect(publicKey?.secret).toBe(false)
  })

  it('gives every field a valid FieldType', () => {
    for (const f of discordDescriptor.configFields) {
      expect(['string', 'string[]', 'number']).toContain(f.type)
    }
  })

  it('pins the trigger ids the templates track consumes (§6.1)', () => {
    expect(discordDescriptor.triggers.map((t) => t.id)).toEqual([
      'message.received',
      'interaction',
      'approval.responded'
    ])
    expect(discordDescriptor.triggers.map((t) => t.id)).toEqual([...DISCORD_TRIGGER_IDS])
  })

  it('pins the action ids (§6.2)', () => {
    expect(discordDescriptor.actions.map((a) => a.id)).toEqual([...DISCORD_ACTION_IDS])
    expect(discordDescriptor.actions.map((a) => a.id)).toEqual([
      'postMessage',
      'postApproval',
      'replyInThread'
    ])
  })
})
