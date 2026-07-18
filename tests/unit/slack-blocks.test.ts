import { describe, it, expect } from 'vitest'
import {
  buildApprovalMessage,
  buildResolvedMessage,
  buildNotifyMessage,
  parseInteraction,
  parseMessageEvent,
  parseSlashCommand,
  correlationKey,
  decodeCorrelation,
  APPROVE_ACTION_ID,
  DENY_ACTION_ID
} from '../../src/main/slack/slack-blocks'
import type { ApprovalRequest } from '../../src/main/flow/types'

const req: ApprovalRequest = {
  runId: 'run-abc',
  nodeId: 'gate1',
  prompt: 'Approve the $250 refund?',
  peek: ['Order #1001', 'Total: $250.00']
}

describe('correlation key', () => {
  it('round-trips runId:nodeId (even a colon-bearing nodeId)', () => {
    expect(decodeCorrelation(correlationKey('run-abc', 'gate:1'))).toEqual({
      runId: 'run-abc',
      nodeId: 'gate:1'
    })
  })
  it('rejects malformed values', () => {
    expect(decodeCorrelation('nocolon')).toBeNull()
    expect(decodeCorrelation(':leading')).toBeNull()
    expect(decodeCorrelation('trailing:')).toBeNull()
  })
})

describe('buildApprovalMessage', () => {
  it('encodes the correlation key in BOTH button values', () => {
    const { blocks } = buildApprovalMessage(req)
    const actions = (blocks as { type: string; elements?: { action_id: string; value: string }[] }[]).find(
      (b) => b.type === 'actions'
    )
    const values = actions!.elements!.map((e) => e.value)
    expect(values).toEqual(['run-abc:gate1', 'run-abc:gate1'])
    const ids = actions!.elements!.map((e) => e.action_id)
    expect(ids).toEqual([APPROVE_ACTION_ID, DENY_ACTION_ID])
  })
  it('renders the peek lines as context blocks', () => {
    const { blocks } = buildApprovalMessage(req)
    const contexts = (blocks as { type: string }[]).filter((b) => b.type === 'context')
    expect(contexts).toHaveLength(2)
  })
})

describe('buildResolvedMessage / notify are button-less', () => {
  it('resolved card carries no actions block and names the decider', () => {
    const { blocks, text } = buildResolvedMessage(req, 'U42', true)
    expect((blocks as { type: string }[]).some((b) => b.type === 'actions')).toBe(false)
    expect(text).toContain('Approved')
    expect(text).toContain('U42')
  })
  it('notify passes through text (+ optional blocks)', () => {
    expect(buildNotifyMessage('hi')).toEqual({ text: 'hi' })
    expect(buildNotifyMessage('hi', [{ x: 1 }])).toEqual({ text: 'hi', blocks: [{ x: 1 }] })
  })
})

describe('parseInteraction', () => {
  const interaction = (actionId: string, value: string): unknown => ({
    type: 'block_actions',
    user: { id: 'U99' },
    actions: [{ action_id: actionId, value }]
  })

  it('round-trips an Approve tap to a normalized decision', () => {
    expect(parseInteraction(interaction(APPROVE_ACTION_ID, 'run-abc:gate1'))).toEqual({
      runId: 'run-abc',
      nodeId: 'gate1',
      approved: true,
      decidedBy: 'U99'
    })
  })
  it('marks a Deny tap approved:false', () => {
    expect(parseInteraction(interaction(DENY_ACTION_ID, 'run-abc:gate1'))?.approved).toBe(false)
  })
  it('returns null for a malformed / foreign payload (never throws)', () => {
    expect(parseInteraction(null)).toBeNull()
    expect(parseInteraction({ type: 'view_submission' })).toBeNull()
    expect(parseInteraction(interaction('some_other_button', 'run-abc:gate1'))).toBeNull()
    expect(parseInteraction(interaction(APPROVE_ACTION_ID, 'bad'))).toBeNull()
    expect(parseInteraction({ type: 'block_actions', actions: [{ action_id: APPROVE_ACTION_ID, value: 'r:n' }] })).toBeNull()
  })
})

describe('parseMessageEvent', () => {
  it('normalizes a user message (bare event and event_callback wrapper)', () => {
    const bare = { type: 'message', channel: 'C1', user: 'U1', text: 'hello', ts: '1.1' }
    expect(parseMessageEvent(bare)).toEqual({ channel: 'C1', user: 'U1', text: 'hello', ts: '1.1' })
    expect(parseMessageEvent({ type: 'event_callback', event: { ...bare, thread_ts: '0.9' } })).toEqual({
      channel: 'C1',
      user: 'U1',
      text: 'hello',
      ts: '1.1',
      threadTs: '0.9'
    })
  })
  it('drops bot echoes and subtyped messages, and malformed input', () => {
    expect(parseMessageEvent({ type: 'message', channel: 'C1', user: 'U1', ts: '1.1', bot_id: 'B1' })).toBeNull()
    expect(parseMessageEvent({ type: 'message', channel: 'C1', ts: '1.1', subtype: 'channel_join' })).toBeNull()
    expect(parseMessageEvent({ type: 'reaction_added' })).toBeNull()
    expect(parseMessageEvent(42)).toBeNull()
  })
})

describe('parseSlashCommand', () => {
  it('normalizes a slash payload', () => {
    expect(
      parseSlashCommand({
        command: '/deploy',
        text: 'staging now',
        channel_id: 'C1',
        user_id: 'U1',
        response_url: 'https://hooks.slack/x'
      })
    ).toEqual({
      command: '/deploy',
      text: 'staging now',
      channel: 'C1',
      user: 'U1',
      responseUrl: 'https://hooks.slack/x'
    })
  })
  it('returns null when the command/channel/user are missing', () => {
    expect(parseSlashCommand({ text: 'x' })).toBeNull()
    expect(parseSlashCommand(null)).toBeNull()
  })
})
