import { describe, it, expect } from 'vitest'
import {
  parseInteractionRequest,
  DEFERRED_ED25519_VERIFIER
} from '../../src/main/discord/discord-interactions-server'

/**
 * The HTTP Interactions path is DEFERRED (Gateway-only MVP); only the PURE parse
 * ships. These guard the PING→PONG handshake and the interaction normalization
 * so the connector stays transport-agnostic when Phase 3 wires the shared-receiver
 * `ed25519` extension (§4.4, §13.7).
 */
describe('parseInteractionRequest', () => {
  it('answers a PING (type 1) with a pong marker', () => {
    expect(parseInteractionRequest(Buffer.from(JSON.stringify({ type: 1 })))).toEqual({
      kind: 'pong'
    })
  })

  it('normalizes any other interaction to the same inbound the Gateway emits', () => {
    const payload = { type: 3, id: 'i1', data: { custom_id: 'lf:approve:r:n' } }
    expect(parseInteractionRequest(Buffer.from(JSON.stringify(payload)))).toEqual({
      kind: 'inbound',
      inbound: { type: 'interaction', payload }
    })
  })

  it('drops malformed / unsupported bodies (never throws)', () => {
    expect(parseInteractionRequest(Buffer.from('not json'))).toBeNull()
    expect(parseInteractionRequest(Buffer.from(JSON.stringify({ no: 'type' })))).toBeNull()
  })

  it('documents the deferred Ed25519 shared-receiver extension shape (§13.7)', () => {
    // Asymmetric: a PUBLIC key, not a shared secret — verify over timestamp+body.
    expect(DEFERRED_ED25519_VERIFIER.scheme).toBe('ed25519')
    expect(DEFERRED_ED25519_VERIFIER.signatureHeader).toBe('X-Signature-Ed25519')
    expect(DEFERRED_ED25519_VERIFIER.timestampHeader).toBe('X-Signature-Timestamp')
  })
})
