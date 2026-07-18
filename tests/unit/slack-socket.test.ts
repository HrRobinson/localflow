import { describe, it, expect } from 'vitest'
import {
  SlackSocket,
  MockSocketTransport,
  type SlackInbound
} from '../../src/main/slack/slack-socket'

async function wired(): Promise<{
  transport: MockSocketTransport
  inbound: SlackInbound[]
  socket: SlackSocket
}> {
  const transport = new MockSocketTransport()
  const inbound: SlackInbound[] = []
  const socket = new SlackSocket({ transport, onInbound: (i) => inbound.push(i) })
  await socket.start()
  return { transport, inbound, socket }
}

describe('SlackSocket', () => {
  it('connects on start and acks + forwards an interactive envelope', async () => {
    const { transport, inbound } = await wired()
    expect(transport.connects).toBe(1)
    transport.emit({ envelopeId: 'e1', type: 'interactive', payload: { a: 1 } })
    expect(transport.acks).toEqual(['e1'])
    expect(inbound).toEqual([{ type: 'interactive', payload: { a: 1 } }])
  })

  it('forwards events_api and slash_commands too', async () => {
    const { transport, inbound } = await wired()
    transport.emit({ envelopeId: 'e2', type: 'events_api', payload: { event: 'x' } })
    transport.emit({ envelopeId: 'e3', type: 'slash_commands', payload: { command: '/x' } })
    expect(inbound.map((i) => i.type)).toEqual(['events_api', 'slash_commands'])
    expect(transport.acks).toEqual(['e2', 'e3'])
  })

  it('ignores a hello handshake frame', async () => {
    const { transport, inbound } = await wired()
    transport.emit({ type: 'hello' })
    expect(inbound).toHaveLength(0)
    expect(transport.acks).toHaveLength(0)
  })

  it('reconnects transparently on a disconnect (refresh) frame', async () => {
    const { transport, inbound } = await wired()
    expect(transport.connects).toBe(1)
    transport.emit({ type: 'disconnect', reason: 'refresh_requested' })
    // Transparent reconnect — connect() called again; no inbound, no ack.
    expect(transport.connects).toBe(2)
    expect(inbound).toHaveLength(0)
  })

  it('does not reconnect after close()', async () => {
    const { transport, socket } = await wired()
    socket.close()
    expect(transport.closed).toBe(true)
    transport.emit({ type: 'disconnect', reason: 'refresh' })
    expect(transport.connects).toBe(1) // no reconnect after close
  })
})
