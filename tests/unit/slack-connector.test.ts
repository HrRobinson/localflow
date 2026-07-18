import { describe, it, expect, vi } from 'vitest'
import { SlackConnector, type ApprovalMechanism } from '../../src/main/slack/slack-connector'
import { MockSlackApi } from '../../src/main/slack/slack-client'
import type { SlackInbound } from '../../src/main/slack/slack-socket'
import type { SlackApprovalDecision } from '../../src/shared/slack'

describe('SlackConnector — action dispatch', () => {
  it('postMessage posts to the default channel and returns the ref', async () => {
    const api = new MockSlackApi()
    const c = new SlackConnector({ api, defaultChannel: 'C-default' })
    const out = (await c.invokeAction('postMessage', { text: 'hello' })) as { channel: string }
    expect(out.channel).toBe('C-default')
    expect(api.calls.postMessage[0]).toMatchObject({ channel: 'C-default', text: 'hello' })
  })

  it('postMessage honors a per-node channel override', async () => {
    const api = new MockSlackApi()
    const c = new SlackConnector({ api, defaultChannel: 'C-default' })
    await c.invokeAction('postMessage', { channel: 'C-other', text: 'hi' })
    expect(api.calls.postMessage[0].channel).toBe('C-other')
  })

  it('replyInThread requires a threadTs and sets thread_ts', async () => {
    const api = new MockSlackApi()
    const c = new SlackConnector({ api, defaultChannel: 'C1' })
    await expect(c.invokeAction('replyInThread', { text: 'hi' })).rejects.toThrow(/needs a 'threadTs'/)
    await c.invokeAction('replyInThread', { text: 'hi', threadTs: '111.2' })
    expect(api.calls.postMessage[0].threadTs).toBe('111.2')
  })

  it('postApproval delegates to the shared approval mechanism and resolves { approved }', async () => {
    const api = new MockSlackApi()
    const approvals: ApprovalMechanism = {
      requestApproval: vi.fn().mockResolvedValue(true),
      handleInteraction: vi.fn()
    }
    const c = new SlackConnector({ api, defaultChannel: 'C1', approvals })
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
    const c = new SlackConnector({ api: new MockSlackApi(), defaultChannel: 'C1', approvals })
    await expect(c.invokeAction('postApproval', { prompt: 'x' })).resolves.toEqual({ approved: false })
  })

  it('rejects an unknown action id legibly', async () => {
    const c = new SlackConnector({ api: new MockSlackApi(), defaultChannel: 'C1' })
    await expect(c.invokeAction('nope', {})).rejects.toThrow(/Slack has no action 'nope'/)
  })
})

describe('SlackConnector — inbound routing', () => {
  it('an interactive envelope drives the approval port', () => {
    const approvals: ApprovalMechanism = {
      requestApproval: vi.fn(),
      handleInteraction: vi.fn()
    }
    const c = new SlackConnector({ api: new MockSlackApi(), defaultChannel: 'C1', approvals })
    const payload = { type: 'block_actions', foo: 1 }
    c.handleInbound({ type: 'interactive', payload } as SlackInbound)
    expect(approvals.handleInteraction).toHaveBeenCalledWith(payload)
  })

  it('a message event fires the message.received trigger with a normalized payload', () => {
    const c = new SlackConnector({ api: new MockSlackApi(), defaultChannel: 'C1' })
    const seen: unknown[] = []
    c.subscribe('message.received', (e) => seen.push(e))
    c.handleInbound({
      type: 'events_api',
      payload: { type: 'event_callback', event: { type: 'message', channel: 'C1', user: 'U1', text: 'hi', ts: '5.5' } }
    })
    expect(seen).toEqual([{ eventId: '5.5', payload: { channel: 'C1', user: 'U1', text: 'hi', ts: '5.5' } }])
  })

  it('a non-/localflow slash fires slash.command; /localflow goes to the control bridge', () => {
    const controlReplies: unknown[] = []
    const control = { handle: vi.fn().mockReturnValue({ text: 'ok', ephemeral: true }) }
    const c = new SlackConnector({
      api: new MockSlackApi(),
      defaultChannel: 'C1',
      control: control as never,
      onControlReply: (_p, r) => controlReplies.push(r)
    })
    const slashSeen: unknown[] = []
    c.subscribe('slash.command', (e) => slashSeen.push(e))

    c.handleInbound({
      type: 'slash_commands',
      payload: { command: '/deploy', text: 'now', channel_id: 'C1', user_id: 'U1', response_url: 'u' }
    })
    expect(slashSeen).toHaveLength(1)

    c.handleInbound({
      type: 'slash_commands',
      payload: { command: '/localflow', text: 'status', channel_id: 'C1', user_id: 'U1', response_url: 'u' }
    })
    expect(control.handle).toHaveBeenCalled()
    expect(controlReplies).toEqual([{ text: 'ok', ephemeral: true }])
    expect(slashSeen).toHaveLength(1) // /localflow is NOT a slash.command trigger
  })

  it('onApprovalDecision fans out to the approval.responded trigger', () => {
    const c = new SlackConnector({ api: new MockSlackApi(), defaultChannel: 'C1' })
    const seen: unknown[] = []
    c.subscribe('approval.responded', (e) => seen.push(e))
    const decision: SlackApprovalDecision = { runId: 'r1', nodeId: 'g1', approved: true, decidedBy: 'U9' }
    c.onApprovalDecision(decision)
    expect(seen).toEqual([{ eventId: 'r1:g1', payload: decision }])
  })
})
