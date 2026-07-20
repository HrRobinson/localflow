import { describe, it, expect } from 'vitest'
import {
  buildApprovalMessage,
  buildResolvedMessage,
  buildNotifyMessage,
  parseInteraction,
  parseInteractionEvent,
  parseMessageEvent,
  parseCommand,
  encodeCustomId,
  parseCustomId,
  interactionRef
} from '../../src/main/discord/discord-components'
import type { ApprovalRequest } from '../../src/main/flow/types'

const req: ApprovalRequest = {
  runId: 'run-abc',
  nodeId: 'gate1',
  prompt: 'Approve the $250 refund?',
  peek: ['Order #1001', 'Total: $250.00']
}

describe('custom_id codec', () => {
  it('round-trips action:runId:nodeId (even a colon-bearing nodeId)', () => {
    expect(parseCustomId(encodeCustomId('approve', 'run-abc', 'gate:1'))).toEqual({
      action: 'approve',
      runId: 'run-abc',
      nodeId: 'gate:1'
    })
    expect(parseCustomId(encodeCustomId('deny', 'run-abc', 'gate1'))).toEqual({
      action: 'deny',
      runId: 'run-abc',
      nodeId: 'gate1'
    })
  })
  it('rejects malformed / foreign custom_ids', () => {
    expect(parseCustomId('nocolons')).toBeNull()
    expect(parseCustomId('other:approve:run:node')).toBeNull()
    expect(parseCustomId('lf:maybe:run:node')).toBeNull()
    expect(parseCustomId('lf:approve:run')).toBeNull()
  })
})

describe('buildApprovalMessage', () => {
  it('encodes the correlation custom_id in BOTH buttons (Approve success, Deny danger)', () => {
    const { components } = buildApprovalMessage(req)
    const row = (components as { components: { style: number; custom_id: string }[] }[])[0]
    expect(row.components.map((b) => b.custom_id)).toEqual([
      'lf:approve:run-abc:gate1',
      'lf:deny:run-abc:gate1'
    ])
    expect(row.components.map((b) => b.style)).toEqual([3, 4]) // SUCCESS, DANGER
  })
  it('renders the peek lines as an embed', () => {
    const built = buildApprovalMessage(req)
    expect(built.embeds).toEqual([{ description: 'Order #1001\nTotal: $250.00' }])
  })
  it('omits the embed when there is no peek content', () => {
    expect(buildApprovalMessage({ ...req, peek: [] }).embeds).toBeUndefined()
  })
})

describe('buildResolvedMessage / notify are button-less', () => {
  it('resolved card carries an empty components array and names the decider', () => {
    const { components, content } = buildResolvedMessage(req, 'U42', true)
    expect(components).toEqual([])
    expect(content).toContain('Approved')
    expect(content).toContain('U42')
  })
  it('notify passes through text (+ optional embeds)', () => {
    expect(buildNotifyMessage('hi')).toEqual({ content: 'hi' })
    expect(buildNotifyMessage('hi', [{ x: 1 }])).toEqual({ content: 'hi', embeds: [{ x: 1 }] })
  })
})

describe('parseInteraction (approval component)', () => {
  const component = (customId: string, user = 'U99'): unknown => ({
    id: 'i1',
    token: 't1',
    type: 3,
    channel_id: 'C1',
    member: { user: { id: user } },
    data: { custom_id: customId }
  })

  it('round-trips an Approve tap to a normalized decision', () => {
    expect(parseInteraction(component('lf:approve:run-abc:gate1'))).toEqual({
      runId: 'run-abc',
      nodeId: 'gate1',
      approved: true,
      decidedBy: 'U99'
    })
  })
  it('marks a Deny tap approved:false and reads a DM user (no member)', () => {
    const dm = {
      id: 'i1',
      token: 't1',
      type: 3,
      channel_id: 'C1',
      user: { id: 'U7' },
      data: { custom_id: 'lf:deny:run-abc:gate1' }
    }
    expect(parseInteraction(dm)?.approved).toBe(false)
    expect(parseInteraction(dm)?.decidedBy).toBe('U7')
  })
  it('returns null for a malformed / foreign payload (never throws)', () => {
    expect(parseInteraction(null)).toBeNull()
    expect(parseInteraction({ type: 2, data: { name: 'x' } })).toBeNull()
    expect(parseInteraction(component('other:approve:run:node'))).toBeNull()
    expect(parseInteraction(component('lf:approve:run'))).toBeNull()
    expect(parseInteraction({ type: 3, data: { custom_id: 'lf:approve:r:n' } })).toBeNull() // no user
  })
  it('interactionRef extracts the callback id + token', () => {
    expect(interactionRef(component('lf:approve:r:n'))).toEqual({
      interactionId: 'i1',
      token: 't1'
    })
    expect(interactionRef({ id: 'i1' })).toBeNull()
  })
})

describe('parseMessageEvent', () => {
  it('normalizes a user MESSAGE_CREATE (guild + text)', () => {
    expect(
      parseMessageEvent({
        id: 'm1',
        channel_id: 'C1',
        guild_id: 'G1',
        author: { id: 'U1', bot: false },
        content: 'hello'
      })
    ).toEqual({ channelId: 'C1', guildId: 'G1', userId: 'U1', text: 'hello', messageId: 'm1' })
  })
  it('yields empty text when content is absent (Message Content intent off)', () => {
    expect(parseMessageEvent({ id: 'm1', channel_id: 'C1', author: { id: 'U1' } })?.text).toBe('')
  })
  it('drops bot echoes and malformed input', () => {
    expect(
      parseMessageEvent({ id: 'm1', channel_id: 'C1', author: { id: 'B1', bot: true } })
    ).toBeNull()
    expect(parseMessageEvent({ id: 'm1', channel_id: 'C1' })).toBeNull() // no author
    expect(parseMessageEvent(42)).toBeNull()
  })
})

describe('parseInteractionEvent (generic interaction trigger)', () => {
  it('normalizes an application command interaction', () => {
    expect(
      parseInteractionEvent({
        id: 'i9',
        token: 't9',
        type: 2,
        channel_id: 'C1',
        member: { user: { id: 'U1' } },
        data: { name: 'deploy' }
      })
    ).toEqual({
      interactionId: 'i9',
      token: 't9',
      type: 2,
      channelId: 'C1',
      userId: 'U1',
      name: 'deploy'
    })
  })
  it('drops a PING (type 1) and malformed input', () => {
    expect(parseInteractionEvent({ type: 1 })).toBeNull()
    expect(parseInteractionEvent(null)).toBeNull()
  })
})

describe('parseCommand', () => {
  it('flattens a subcommand + option into name/text', () => {
    expect(
      parseCommand({
        id: 'i1',
        token: 't1',
        type: 2,
        channel_id: 'C1',
        member: { user: { id: 'U1' } },
        data: {
          name: 'localflow',
          options: [{ name: 'run', options: [{ name: 'flow', value: 'refund-worker' }] }]
        }
      })
    ).toEqual({
      name: 'localflow',
      text: 'run refund-worker',
      channelId: 'C1',
      userId: 'U1',
      interactionId: 'i1',
      token: 't1'
    })
  })
  it('returns null for a non-command interaction', () => {
    expect(parseCommand({ type: 3, data: { custom_id: 'x' } })).toBeNull()
    expect(parseCommand(null)).toBeNull()
  })
})
