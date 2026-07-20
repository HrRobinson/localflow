import { describe, it, expect } from 'vitest'
import {
  MockIngressSource,
  GcpPubSubIngressSource,
  type Ack,
  type Delivery
} from '../../src/main/hosted/ingress-source'

function delivery(over: Partial<Delivery> = {}): Delivery {
  return {
    integration: 'shopify',
    ingressUrlId: 'url_1',
    rawBody: Buffer.from('{"a":1}'),
    headers: { 'x-sig': 'abc' },
    ...over
  }
}

describe('MockIngressSource', () => {
  it('replays every delivery to the handler and records each resolved ack, in order', async () => {
    const deliveries = [
      delivery({ ingressUrlId: 'a' }),
      delivery({ ingressUrlId: 'b' }),
      delivery({ ingressUrlId: 'c' })
    ]
    const verdicts: Record<string, Ack> = { a: 'ack', b: 'nack', c: 'ack' }
    const source = new MockIngressSource(deliveries)
    await source.drainOnce(async (d) => verdicts[d.ingressUrlId])
    expect(source.acks.map((a) => a.delivery.ingressUrlId)).toEqual(['a', 'b', 'c'])
    expect(source.acks.map((a) => a.ack)).toEqual(['ack', 'nack', 'ack'])
  })

  it('drain() returns an unsubscribe and stops replaying once called', async () => {
    const source = new MockIngressSource([delivery({ ingressUrlId: 'x' })])
    const stop = source.drain(async () => 'ack')
    expect(typeof stop).toBe('function')
    await source.settled
    stop()
    expect(source.acks).toHaveLength(1)
  })

  it('acks only AFTER the handler resolves (never before the local handoff)', async () => {
    let handlerResolved = false
    const source = new MockIngressSource([delivery()])
    await source.drainOnce(async () => {
      // The ack must not be recorded until this resolves.
      expect(source.acks).toHaveLength(0)
      handlerResolved = true
      return 'ack'
    })
    expect(handlerResolved).toBe(true)
    expect(source.acks).toHaveLength(1)
  })
})

describe('GcpPubSubIngressSource (deferred live transport)', () => {
  it('throws a legible "not wired yet" error rather than touching the network', () => {
    const source = new GcpPubSubIngressSource({
      subscription: 'projects/p/subscriptions/s',
      token: async () => 'scoped-token'
    })
    expect(() => source.drain(async () => 'ack')).toThrow(/not wired yet/i)
    expect(() => source.drain(async () => 'ack')).toThrow(/Pub\/Sub/i)
  })
})
