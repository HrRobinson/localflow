import { describe, it, expect, vi } from 'vitest'
import {
  DiscordApprovalPort,
  SETTLED_CAP,
  type ApprovalTimer
} from '../../src/main/discord/discord-approval-port'
import { MockDiscordApi, CALLBACK_UPDATE_MESSAGE } from '../../src/main/discord/discord-client'
import { encodeCustomId } from '../../src/main/discord/discord-components'
import type { ApprovalRequest } from '../../src/main/flow/types'
import type { DiscordApprovalDecision } from '../../src/shared/discord'

const req: ApprovalRequest = {
  runId: 'run-1',
  nodeId: 'gate-1',
  prompt: 'Approve the $250 refund?',
  peek: ['Order #1001', 'Total: $250.00']
}

/** A manual timer: captures the callback so a test fires expiry deterministically. */
function manualTimer(): { timer: ApprovalTimer; fire: () => void; cancelled: () => boolean } {
  let cb: (() => void) | null = null
  let cancelled = false
  return {
    timer: (fn) => {
      cb = fn
      return () => {
        cancelled = true
        cb = null
      }
    },
    fire: () => cb?.(),
    cancelled: () => cancelled
  }
}

/** A component INTERACTION_CREATE for an Approve/Deny tap. */
const tap = (
  action: 'approve' | 'deny',
  runId = 'run-1',
  nodeId = 'gate-1',
  user = 'U42'
): unknown => ({
  id: 'interaction-x',
  token: 'tok-x',
  type: 3,
  channel_id: 'C1',
  member: { user: { id: user } },
  message: { id: 'msg-1' },
  data: { custom_id: encodeCustomId(action, runId, nodeId) }
})

describe('DiscordApprovalPort — the second real ApprovalPort', () => {
  it('posts an approval message and parks a pending resolver (needs-you)', async () => {
    const api = new MockDiscordApi()
    const port = new DiscordApprovalPort({ api, channel: 'C1' })
    let resolved = false
    const p = port.requestApproval(req).then((v) => {
      resolved = true
      return v
    })
    await Promise.resolve()
    expect(api.calls.postMessage).toHaveLength(1)
    expect(api.calls.postMessage[0].channelId).toBe('C1')
    expect(port.pendingCount()).toBe(1)
    expect(resolved).toBe(false) // still awaiting the human
    port.handleInteraction(tap('approve'))
    await p
  })

  it('an Approve tap resolves true, acks+strips buttons in ONE UPDATE_MESSAGE call, emits the decision', async () => {
    const api = new MockDiscordApi()
    const decisions: DiscordApprovalDecision[] = []
    const port = new DiscordApprovalPort({
      api,
      channel: 'C1',
      onDecision: (d) => decisions.push(d)
    })
    const p = port.requestApproval(req)
    await Promise.resolve()
    port.handleInteraction(tap('approve'))
    expect(await p).toBe(true)
    // Finalize via the interaction-callback (ack + update in one call, ≤3s).
    expect(api.calls.respondToInteraction).toHaveLength(1)
    const cb = api.calls.respondToInteraction[0]
    expect(cb.type).toBe(CALLBACK_UPDATE_MESSAGE)
    expect(cb.interactionId).toBe('interaction-x')
    expect(cb.token).toBe('tok-x')
    expect(JSON.stringify(cb.body)).toContain('Approved')
    expect(JSON.stringify(cb.body)).not.toContain('lf:') // button-less — not tappable twice
    expect(api.calls.editMessage).toHaveLength(0) // NOT the REST path on a live tap
    expect(decisions).toEqual([
      { runId: 'run-1', nodeId: 'gate-1', approved: true, decidedBy: 'U42' }
    ])
    expect(port.pendingCount()).toBe(0)
  })

  it('a Deny tap resolves false', async () => {
    const api = new MockDiscordApi()
    const port = new DiscordApprovalPort({ api, channel: 'C1' })
    const p = port.requestApproval(req)
    await Promise.resolve()
    port.handleInteraction(tap('deny'))
    expect(await p).toBe(false)
    expect(JSON.stringify(api.calls.respondToInteraction[0].body)).toContain('Denied')
  })

  it('the liveness timeout resolves false and stamps Expired via REST PATCH (a "no", not a failure)', async () => {
    const api = new MockDiscordApi()
    const mt = manualTimer()
    const port = new DiscordApprovalPort({ api, channel: 'C1', timer: mt.timer, timeoutMs: 5 })
    const p = port.requestApproval(req)
    await Promise.resolve()
    mt.fire()
    expect(await p).toBe(false)
    // No interaction token in hand on timeout → REST editMessage (PATCH), §7.3.
    expect(api.calls.editMessage).toHaveLength(1)
    expect(JSON.stringify(api.calls.editMessage[0].body)).toContain('Expired')
    expect(api.calls.respondToInteraction).toHaveLength(0)
    expect(port.pendingCount()).toBe(0)
  })

  it('a tap cancels the timeout timer', async () => {
    const api = new MockDiscordApi()
    const mt = manualTimer()
    const port = new DiscordApprovalPort({ api, channel: 'C1', timer: mt.timer })
    const p = port.requestApproval(req)
    await Promise.resolve()
    port.handleInteraction(tap('approve'))
    await p
    expect(mt.cancelled()).toBe(true)
  })

  it('is idempotent — a second tap is a silent no-op (resolves once, one callback)', async () => {
    const api = new MockDiscordApi()
    const onDecision = vi.fn()
    const port = new DiscordApprovalPort({ api, channel: 'C1', onDecision })
    const p = port.requestApproval(req)
    await Promise.resolve()
    port.handleInteraction(tap('approve'))
    port.handleInteraction(tap('deny')) // double tap
    expect(await p).toBe(true) // first tap won; second is a no-op
    expect(api.calls.respondToInteraction).toHaveLength(1)
    expect(onDecision).toHaveBeenCalledTimes(1)
  })

  it('an interaction for an unknown/stale gate is dropped with a "no longer active" update', async () => {
    const api = new MockDiscordApi()
    const port = new DiscordApprovalPort({ api, channel: 'C1' })
    port.handleInteraction(tap('approve', 'run-x', 'gate-x'))
    expect(api.calls.respondToInteraction).toHaveLength(1)
    expect(JSON.stringify(api.calls.respondToInteraction[0].body)).toMatch(/no longer active/)
  })

  it('rejects requestApproval with the real cause when the post fails (a real failure, not a "no")', async () => {
    const api = new MockDiscordApi({ postStatus: 404 })
    const port = new DiscordApprovalPort({ api, channel: 'Cbad' })
    await expect(port.requestApproval(req)).rejects.toThrow(/404/)
    expect(port.pendingCount()).toBe(0)
  })
})

describe('DiscordApprovalPort — concurrency + resource hardening', () => {
  it('two concurrent gates: a tap resolves ONLY its own run, the other stays pending', async () => {
    const api = new MockDiscordApi()
    const port = new DiscordApprovalPort({ api, channel: 'C1' })
    const reqA: ApprovalRequest = { ...req, runId: 'run-A', nodeId: 'gate-1' }
    const reqB: ApprovalRequest = { ...req, runId: 'run-B', nodeId: 'gate-1' }
    let aResolved: boolean | null = null
    let bResolved: boolean | null = null
    const pA = port.requestApproval(reqA).then((v) => (aResolved = v))
    const pB = port.requestApproval(reqB).then((v) => (bResolved = v))
    await Promise.resolve()
    expect(port.pendingCount()).toBe(2)

    port.handleInteraction(tap('approve', 'run-B', 'gate-1'))
    await pB
    expect(bResolved).toBe(true)
    expect(aResolved).toBeNull() // A untouched
    expect(port.pendingCount()).toBe(1)

    port.handleInteraction(tap('deny', 'run-A', 'gate-1'))
    await pA
    expect(aResolved).toBe(false)
    expect(port.pendingCount()).toBe(0)
  })

  it('refuses to open a SECOND gate for an already-pending key (never orphans the first)', async () => {
    const api = new MockDiscordApi()
    const port = new DiscordApprovalPort({ api, channel: 'C1' })
    const first = port.requestApproval(req)
    await Promise.resolve()
    expect(port.pendingCount()).toBe(1)
    await expect(port.requestApproval(req)).rejects.toThrow(/already pending/)
    expect(port.pendingCount()).toBe(1)
    expect(api.calls.postMessage).toHaveLength(1)
    port.handleInteraction(tap('approve'))
    expect(await first).toBe(true)
  })

  it('bounds the settled tombstone set FIFO — it never grows past SETTLED_CAP', async () => {
    const api = new MockDiscordApi()
    const port = new DiscordApprovalPort({ api, channel: 'C1' })
    for (let i = 0; i < SETTLED_CAP + 5; i++) {
      const r: ApprovalRequest = { ...req, runId: `run-${i}`, nodeId: 'g' }
      const p = port.requestApproval(r)
      await Promise.resolve()
      port.handleInteraction(tap('approve', `run-${i}`, 'g'))
      await p
    }
    expect(port.settledCount()).toBe(SETTLED_CAP)
    const before = api.calls.respondToInteraction.length
    port.handleInteraction(tap('approve', 'run-0', 'g'))
    expect(api.calls.respondToInteraction).toHaveLength(before + 1)
    expect(JSON.stringify(api.calls.respondToInteraction[before].body)).toMatch(/no longer active/)
  })
})

describe('DiscordApprovalPort — never renders a secret', () => {
  it('keeps no token material in any posted/updated message or emitted decision', async () => {
    const api = new MockDiscordApi()
    const captured: string[] = []
    const port = new DiscordApprovalPort({
      api,
      channel: 'C1',
      onDecision: (d) => captured.push(JSON.stringify(d)),
      log: (m) => captured.push(m)
    })
    const p = port.requestApproval({ ...req, peek: ['Order summary — no secrets here'] })
    await Promise.resolve()
    port.handleInteraction(tap('approve'))
    await p
    captured.push(JSON.stringify(api.calls.postMessage))
    captured.push(JSON.stringify(api.calls.respondToInteraction))
    // The port never touches a token; assert no bot-token-shaped material leaks.
    for (const s of captured) {
      expect(s).not.toMatch(/Bot [A-Za-z0-9._-]{20,}/)
    }
  })
})
