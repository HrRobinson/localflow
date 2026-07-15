import { describe, it, expect } from 'vitest'
import { NetworkTap } from '../../src/main/network-tap'
import type { ConsoleEventInput } from '../../src/shared/console'

function make(): {
  tap: NetworkTap
  emitted: ConsoleEventInput[][]
  setNow: (n: number) => void
} {
  let now = 1000
  const emitted: ConsoleEventInput[][] = []
  const tap = new NetworkTap({
    environment: 3,
    sessionId: 'pane-1',
    emitBatch: (inputs) => emitted.push(inputs),
    now: () => now
  })
  return { tap, emitted, setNow: (n) => (now = n) }
}

describe('NetworkTap', () => {
  it('coalesces request/response/finished into one finished row', () => {
    const { tap, emitted, setNow } = make()
    tap.onMessage('Network.requestWillBeSent', {
      requestId: 'r1',
      request: { url: 'https://x/api', method: 'GET' },
      type: 'XHR'
    })
    tap.onMessage('Network.responseReceived', {
      requestId: 'r1',
      response: { status: 200, fromDiskCache: false }
    })
    setNow(1120)
    tap.onMessage('Network.loadingFinished', { requestId: 'r1', encodedDataLength: 512 })
    tap.flush()
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toHaveLength(1)
    expect(emitted[0][0].detail).toMatchObject({
      source: 'network',
      requestId: 'r1',
      method: 'GET',
      status: 200,
      sizeBytes: 512,
      durationMs: 120,
      fromCache: false
    })
  })

  it('loadingFailed produces one failed row with errorText', () => {
    const { tap, emitted } = make()
    tap.onMessage('Network.requestWillBeSent', {
      requestId: 'r1',
      request: { url: '/boom', method: 'GET' }
    })
    tap.onMessage('Network.loadingFailed', { requestId: 'r1', errorText: 'net::ERR_FAILED' })
    tap.flush()
    expect(emitted[0][0].detail).toMatchObject({
      source: 'network',
      failed: true,
      errorText: 'net::ERR_FAILED'
    })
  })

  it('flushIncomplete emits every pending entry as an incomplete row', () => {
    const { tap, emitted } = make()
    tap.onMessage('Network.requestWillBeSent', {
      requestId: 'r1',
      request: { url: '/pending', method: 'POST' }
    })
    tap.flushIncomplete()
    expect(emitted[0][0].detail).toMatchObject({
      source: 'network',
      method: 'POST',
      incomplete: true
    })
  })

  it('sweeps a request pending past 30s into an incomplete row on flush', () => {
    const { tap, emitted, setNow } = make()
    tap.onMessage('Network.requestWillBeSent', {
      requestId: 'r1',
      request: { url: '/slow', method: 'GET' }
    })
    setNow(1000 + 30_001)
    tap.flush()
    expect(emitted[0][0].detail).toMatchObject({ source: 'network', incomplete: true })
  })
})
