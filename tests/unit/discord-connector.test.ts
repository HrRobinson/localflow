import { describe, it, expect, vi } from 'vitest'
import { DiscordConnector, type ApprovalMechanism } from '../../src/main/discord/discord-connector'
import { MockDiscordApi } from '../../src/main/discord/discord-client'
import { encodeCustomId } from '../../src/main/discord/discord-components'
import type { DiscordInbound } from '../../src/main/discord/discord-gateway'
import type { DiscordApprovalDecision } from '../../src/shared/discord'

describe('DiscordConnector — action dispatch', () => {
  it('postMessage posts to the default channel and returns the ref', async () => {
    const api = new MockDiscordApi()
    const c = new DiscordConnector({ api, defaultChannel: 'C-default' })
    const out = (await c.invokeAction('postMessage', { text: 'hello' })) as { channelId: string }
    expect(out.channelId).toBe('C-default')
    expect(api.calls.postMessage[0]).toMatchObject({ channelId: 'C-default' })
    expect(api.calls.postMessage[0].body.content).toBe('hello')
  })

  it('postMessage honors a per-node channel override', async () => {
    const api = new MockDiscordApi()
    const c = new DiscordConnector({ api, defaultChannel: 'C-default' })
    await c.invokeAction('postMessage', { channel: 'C-other', text: 'hi' })
    expect(api.calls.postMessage[0].channelId).toBe('C-other')
  })

  it('replyInThread requires a threadId and posts to the thread channel', async () => {
    const api = new MockDiscordApi()
    const c = new DiscordConnector({ api, defaultChannel: 'C1' })
    await expect(c.invokeAction('replyInThread', { text: 'hi' })).rejects.toThrow(
      /needs a 'threadId'/
    )
    await c.invokeAction('replyInThread', { text: 'hi', threadId: 'T-1' })
    expect(api.calls.postMessage[0].channelId).toBe('T-1')
  })

  it('postApproval delegates to the shared approval mechanism and resolves { approved }', async () => {
    const api = new MockDiscordApi()
    const approvals: ApprovalMechanism = {
      requestApproval: vi.fn().mockResolvedValue(true),
      handleInteraction: vi.fn()
    }
    const c = new DiscordConnector({ api, defaultChannel: 'C1', approvals })
    const out = await c.invokeAction('postApproval', { prompt: 'ship it?', peek: ['diff'] })
    expect(out).toEqual({ approved: true })
    expect(approvals.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'ship it?', peek: ['diff'], nodeId: 'postApproval' })
    )
  })

  it('a denied postApproval resolves { approved: false } — a fact, not a rejection', async () => {
    const approvals: ApprovalMechanism = {
      requestApproval: vi.fn().mockResolvedValue(false),
      handleInteraction: vi.fn()
    }
    const c = new DiscordConnector({ api: new MockDiscordApi(), defaultChannel: 'C1', approvals })
    await expect(c.invokeAction('postApproval', { prompt: 'x' })).resolves.toEqual({
      approved: false
    })
  })

  it('rejects an unknown action id legibly', async () => {
    const c = new DiscordConnector({ api: new MockDiscordApi(), defaultChannel: 'C1' })
    await expect(c.invokeAction('nope', {})).rejects.toThrow(/Discord has no action 'nope'/)
  })
})

describe('DiscordConnector — inbound routing', () => {
  const approvalInteraction = {
    id: 'i1',
    token: 't1',
    type: 3,
    channel_id: 'C1',
    member: { user: { id: 'U1' } },
    data: { custom_id: encodeCustomId('approve', 'r1', 'g1') }
  }

  it('an approval-component interaction drives the approval port', () => {
    const approvals: ApprovalMechanism = { requestApproval: vi.fn(), handleInteraction: vi.fn() }
    const c = new DiscordConnector({ api: new MockDiscordApi(), defaultChannel: 'C1', approvals })
    c.handleInbound({ type: 'interaction', payload: approvalInteraction } as DiscordInbound)
    expect(approvals.handleInteraction).toHaveBeenCalledWith(approvalInteraction)
  })

  it('a MESSAGE_CREATE fires the message.received trigger with a normalized payload', () => {
    const c = new DiscordConnector({ api: new MockDiscordApi(), defaultChannel: 'C1' })
    const seen: unknown[] = []
    c.subscribe('message.received', (e) => seen.push(e))
    c.handleInbound({
      type: 'message',
      payload: { id: 'm5', channel_id: 'C1', author: { id: 'U1' }, content: 'hi' }
    })
    expect(seen).toEqual([
      { eventId: 'm5', payload: { channelId: 'C1', userId: 'U1', text: 'hi', messageId: 'm5' } }
    ])
  })

  it('a non-/localflow command fires the interaction trigger; /localflow goes to the bridge', () => {
    const controlReplies: unknown[] = []
    const control = { handle: vi.fn().mockReturnValue({ text: 'ok', ephemeral: true }) }
    const c = new DiscordConnector({
      api: new MockDiscordApi(),
      defaultChannel: 'C1',
      control: control as never,
      onControlReply: (_ref, r) => controlReplies.push(r)
    })
    const seen: unknown[] = []
    c.subscribe('interaction', (e) => seen.push(e))

    // A user-defined command → the `interaction` trigger.
    c.handleInbound({
      type: 'interaction',
      payload: {
        id: 'i2',
        token: 't2',
        type: 2,
        channel_id: 'C1',
        member: { user: { id: 'U1' } },
        data: { name: 'deploy' }
      }
    })
    expect(seen).toHaveLength(1)

    // The reserved /localflow → the control bridge, NOT the trigger.
    c.handleInbound({
      type: 'interaction',
      payload: {
        id: 'i3',
        token: 't3',
        type: 2,
        channel_id: 'C1',
        member: { user: { id: 'U1' } },
        data: { name: 'localflow', options: [{ name: 'status' }] }
      }
    })
    expect(control.handle).toHaveBeenCalled()
    expect(controlReplies).toEqual([{ text: 'ok', ephemeral: true }])
    expect(seen).toHaveLength(1) // /localflow is NOT an interaction trigger
  })

  it('onApprovalDecision fans out to the approval.responded trigger', () => {
    const c = new DiscordConnector({ api: new MockDiscordApi(), defaultChannel: 'C1' })
    const seen: unknown[] = []
    c.subscribe('approval.responded', (e) => seen.push(e))
    const decision: DiscordApprovalDecision = {
      runId: 'r1',
      nodeId: 'g1',
      approved: true,
      decidedBy: 'U9'
    }
    c.onApprovalDecision(decision)
    expect(seen).toEqual([{ eventId: 'r1:g1', payload: decision }])
  })
})
