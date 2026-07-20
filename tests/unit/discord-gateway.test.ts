import { describe, it, expect } from 'vitest'
import {
  DiscordGateway,
  MockGatewayTransport,
  OP_HELLO,
  OP_DISPATCH,
  OP_IDENTIFY,
  OP_RESUME,
  OP_HEARTBEAT,
  OP_RECONNECT,
  OP_INVALID_SESSION,
  type DiscordInbound,
  type HeartbeatTimer
} from '../../src/main/discord/discord-gateway'

/** A manual heartbeat scheduler: captures the callback so a test fires it. */
function manualHeartbeat(): { timer: HeartbeatTimer; fire: () => void } {
  let cb: (() => void) | null = null
  return { timer: (fn) => ((cb = fn), () => (cb = null)), fire: () => cb?.() }
}

async function wired(hb?: HeartbeatTimer): Promise<{
  transport: MockGatewayTransport
  inbound: DiscordInbound[]
  gateway: DiscordGateway
}> {
  const transport = new MockGatewayTransport()
  const inbound: DiscordInbound[] = []
  const gateway = new DiscordGateway({
    transport,
    token: () => 'the-bot-token',
    onInbound: (i) => inbound.push(i),
    heartbeatTimer: hb ?? (() => () => {})
  })
  await gateway.start()
  return { transport, inbound, gateway }
}

describe('DiscordGateway', () => {
  it('connects on start and IDENTIFYs on HELLO', async () => {
    const { transport } = await wired()
    expect(transport.connects).toBe(1)
    transport.emit({ op: OP_HELLO, d: { heartbeat_interval: 41250 } })
    const identify = transport.sendsOfOp(OP_IDENTIFY)
    expect(identify).toHaveLength(1)
    expect((identify[0].d as { token: string }).token).toBe('the-bot-token')
  })

  it('heartbeats on the HELLO interval carrying the last sequence', async () => {
    const hb = manualHeartbeat()
    const { transport } = await wired(hb.timer)
    transport.emit({ op: OP_HELLO, d: { heartbeat_interval: 1000 } })
    transport.emit({ op: OP_DISPATCH, t: 'GUILD_CREATE', s: 7, d: {} })
    hb.fire()
    const beats = transport.sendsOfOp(OP_HEARTBEAT)
    expect(beats).toHaveLength(1)
    expect(beats[0].d).toBe(7) // last sequence seen
  })

  it('forwards MESSAGE_CREATE and INTERACTION_CREATE as normalized inbound', async () => {
    const { transport, inbound } = await wired()
    transport.emit({ op: OP_DISPATCH, t: 'MESSAGE_CREATE', s: 1, d: { id: 'm1' } })
    transport.emit({ op: OP_DISPATCH, t: 'INTERACTION_CREATE', s: 2, d: { id: 'i1' } })
    expect(inbound).toEqual([
      { type: 'message', payload: { id: 'm1' } },
      { type: 'interaction', payload: { id: 'i1' } }
    ])
  })

  it('captures the session id from READY and RESUMEs after a RECONNECT', async () => {
    const { transport } = await wired()
    transport.emit({ op: OP_HELLO, d: { heartbeat_interval: 1000 } })
    transport.emit({
      op: OP_DISPATCH,
      t: 'READY',
      s: 1,
      d: { session_id: 'sess-1', resume_gateway_url: 'wss://resume' }
    })
    transport.emit({ op: OP_RECONNECT })
    expect(transport.connects).toBe(2) // transparent reconnect
    // The next HELLO after the reconnect RESUMEs (not a fresh IDENTIFY).
    transport.emit({ op: OP_HELLO, d: { heartbeat_interval: 1000 } })
    const resume = transport.sendsOfOp(OP_RESUME)
    expect(resume).toHaveLength(1)
    expect(resume[0].d).toMatchObject({ session_id: 'sess-1', seq: 1 })
  })

  it('re-IDENTIFYs (fresh) after an INVALID_SESSION', async () => {
    const { transport } = await wired()
    transport.emit({ op: OP_HELLO, d: { heartbeat_interval: 1000 } })
    transport.emit({ op: OP_DISPATCH, t: 'READY', s: 1, d: { session_id: 'sess-1' } })
    transport.emit({ op: OP_INVALID_SESSION })
    expect(transport.connects).toBe(2)
    transport.emit({ op: OP_HELLO, d: { heartbeat_interval: 1000 } })
    // Session dropped → a fresh IDENTIFY, no RESUME.
    expect(transport.sendsOfOp(OP_RESUME)).toHaveLength(0)
    expect(transport.sendsOfOp(OP_IDENTIFY)).toHaveLength(2) // initial + re-identify
  })

  it('does not reconnect after close()', async () => {
    const { transport, gateway } = await wired()
    gateway.close()
    expect(transport.closed).toBe(true)
    transport.emit({ op: OP_RECONNECT })
    expect(transport.connects).toBe(1)
  })
})
