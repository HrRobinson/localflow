import { describe, it, expect, vi } from 'vitest'
import {
  SlackApprovalPort,
  SETTLED_CAP,
  type ApprovalTimer
} from '../../src/main/slack/slack-approval-port'
import { MockSlackApi } from '../../src/main/slack/slack-client'
import {
  APPROVE_ACTION_ID,
  DENY_ACTION_ID,
  correlationKey
} from '../../src/main/slack/slack-blocks'
import type { ApprovalRequest } from '../../src/main/flow/types'
import type { SlackApprovalDecision } from '../../src/shared/slack'

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

const tap = (actionId: string, runId = 'run-1', nodeId = 'gate-1', user = 'U42'): unknown => ({
  type: 'block_actions',
  user: { id: user },
  channel: { id: 'C1' },
  message: { ts: '1001.000100' },
  actions: [{ action_id: actionId, value: correlationKey(runId, nodeId) }]
})

describe('SlackApprovalPort — the first real ApprovalPort', () => {
  it('posts an approval message and parks a pending resolver (needs-you)', async () => {
    const api = new MockSlackApi()
    const port = new SlackApprovalPort({ api, channel: 'C1' })
    let resolved = false
    const p = port.requestApproval(req).then((v) => {
      resolved = true
      return v
    })
    await Promise.resolve()
    expect(api.calls.postMessage).toHaveLength(1)
    expect(api.calls.postMessage[0].channel).toBe('C1')
    expect(port.pendingCount()).toBe(1)
    expect(resolved).toBe(false) // still awaiting the human
    // resolve it so the promise doesn't dangle
    port.handleInteraction(tap(APPROVE_ACTION_ID))
    await p
  })

  it('an Approve tap resolves true, updates to a button-less card, emits the decision', async () => {
    const api = new MockSlackApi()
    const decisions: SlackApprovalDecision[] = []
    const port = new SlackApprovalPort({ api, channel: 'C1', onDecision: (d) => decisions.push(d) })
    const p = port.requestApproval(req)
    await Promise.resolve()
    port.handleInteraction(tap(APPROVE_ACTION_ID))
    expect(await p).toBe(true)
    expect(api.calls.updateMessage).toHaveLength(1)
    const update = api.calls.updateMessage[0]
    expect(JSON.stringify(update.blocks)).not.toContain('actions') // button-less
    expect(JSON.stringify(update.blocks)).toContain('Approved')
    expect(decisions).toEqual([
      { runId: 'run-1', nodeId: 'gate-1', approved: true, decidedBy: 'U42' }
    ])
    expect(port.pendingCount()).toBe(0)
  })

  it('a Deny tap resolves false', async () => {
    const api = new MockSlackApi()
    const port = new SlackApprovalPort({ api, channel: 'C1' })
    const p = port.requestApproval(req)
    await Promise.resolve()
    port.handleInteraction(tap(DENY_ACTION_ID))
    expect(await p).toBe(false)
    expect(JSON.stringify(api.calls.updateMessage[0].blocks)).toContain('Denied')
  })

  it('the liveness timeout resolves false and stamps Expired (a "no", not a failure)', async () => {
    const api = new MockSlackApi()
    const mt = manualTimer()
    const port = new SlackApprovalPort({ api, channel: 'C1', timer: mt.timer, timeoutMs: 5 })
    const p = port.requestApproval(req)
    await Promise.resolve()
    mt.fire()
    expect(await p).toBe(false)
    expect(JSON.stringify(api.calls.updateMessage[0].blocks)).toContain('Expired')
    expect(port.pendingCount()).toBe(0)
  })

  it('a tap cancels the timeout timer', async () => {
    const api = new MockSlackApi()
    const mt = manualTimer()
    const port = new SlackApprovalPort({ api, channel: 'C1', timer: mt.timer })
    const p = port.requestApproval(req)
    await Promise.resolve()
    port.handleInteraction(tap(APPROVE_ACTION_ID))
    await p
    expect(mt.cancelled()).toBe(true)
  })

  it('is idempotent — a second tap is a silent no-op (resolves once, one update)', async () => {
    const api = new MockSlackApi()
    const onDecision = vi.fn()
    const port = new SlackApprovalPort({ api, channel: 'C1', onDecision })
    const p = port.requestApproval(req)
    await Promise.resolve()
    port.handleInteraction(tap(APPROVE_ACTION_ID))
    port.handleInteraction(tap(DENY_ACTION_ID)) // double tap
    expect(await p).toBe(true) // first tap won; second is a no-op
    expect(api.calls.updateMessage).toHaveLength(1)
    expect(onDecision).toHaveBeenCalledTimes(1)
  })

  it('an interaction for an unknown/stale gate is dropped with a "no longer active" update', async () => {
    const api = new MockSlackApi()
    const port = new SlackApprovalPort({ api, channel: 'C1' })
    // No requestApproval for this key → unknown gate.
    port.handleInteraction(tap(APPROVE_ACTION_ID, 'run-x', 'gate-x'))
    expect(api.calls.updateMessage).toHaveLength(1)
    expect(api.calls.updateMessage[0].text).toMatch(/no longer active/)
  })

  it('rejects requestApproval with the real cause when the post fails (a real failure, not a "no")', async () => {
    const api = new MockSlackApi({ postError: 'channel_not_found' })
    const port = new SlackApprovalPort({ api, channel: 'Cbad' })
    await expect(port.requestApproval(req)).rejects.toThrow(/channel_not_found/)
    expect(port.pendingCount()).toBe(0)
  })
})

describe('SlackApprovalPort — concurrency + resource hardening', () => {
  it('two concurrent gates: a tap resolves ONLY its own run, the other stays pending', async () => {
    const api = new MockSlackApi()
    const port = new SlackApprovalPort({ api, channel: 'C1' })
    const reqA: ApprovalRequest = { ...req, runId: 'run-A', nodeId: 'gate-1' }
    const reqB: ApprovalRequest = { ...req, runId: 'run-B', nodeId: 'gate-1' }
    let aResolved: boolean | null = null
    let bResolved: boolean | null = null
    const pA = port.requestApproval(reqA).then((v) => (aResolved = v))
    const pB = port.requestApproval(reqB).then((v) => (bResolved = v))
    await Promise.resolve()
    expect(port.pendingCount()).toBe(2)

    // Tap B only. A must remain parked; B resolves true.
    port.handleInteraction(tap(APPROVE_ACTION_ID, 'run-B', 'gate-1'))
    await pB
    expect(bResolved).toBe(true)
    expect(aResolved).toBeNull() // A untouched
    expect(port.pendingCount()).toBe(1)

    // Now resolve A (deny) — it gets its OWN decision, not B's.
    port.handleInteraction(tap(DENY_ACTION_ID, 'run-A', 'gate-1'))
    await pA
    expect(aResolved).toBe(false)
    expect(port.pendingCount()).toBe(0)
  })

  it('refuses to open a SECOND gate for an already-pending key (never orphans the first)', async () => {
    const api = new MockSlackApi()
    const port = new SlackApprovalPort({ api, channel: 'C1' })
    const first = port.requestApproval(req)
    await Promise.resolve()
    expect(port.pendingCount()).toBe(1)
    // A second request for the SAME (runId, nodeId) must reject, not clobber.
    await expect(port.requestApproval(req)).rejects.toThrow(/already pending/)
    // The FIRST gate is untouched — one pending, one Slack post (no duplicate).
    expect(port.pendingCount()).toBe(1)
    expect(api.calls.postMessage).toHaveLength(1)
    // The original resolver still works.
    port.handleInteraction(tap(APPROVE_ACTION_ID))
    expect(await first).toBe(true)
  })

  it('bounds the settled tombstone set FIFO — it never grows past SETTLED_CAP', async () => {
    const api = new MockSlackApi()
    const port = new SlackApprovalPort({ api, channel: 'C1' })
    for (let i = 0; i < SETTLED_CAP + 5; i++) {
      const r: ApprovalRequest = { ...req, runId: `run-${i}`, nodeId: 'g' }
      const p = port.requestApproval(r)
      await Promise.resolve()
      port.handleInteraction(tap(APPROVE_ACTION_ID, `run-${i}`, 'g'))
      await p
    }
    expect(port.settledCount()).toBe(SETTLED_CAP)
    // The evicted (oldest) tombstones degrade to the legible stale card, not a
    // silent no-op — a redelivery of run-0 hits the "no longer active" path.
    const before = api.calls.updateMessage.length
    port.handleInteraction(tap(APPROVE_ACTION_ID, 'run-0', 'g'))
    expect(api.calls.updateMessage).toHaveLength(before + 1)
    expect(api.calls.updateMessage[before].text).toMatch(/no longer active/)
  })
})

describe('SlackApprovalPort — never renders a secret', () => {
  it('keeps no token material in any posted/updated message or emitted decision', async () => {
    const api = new MockSlackApi()
    const captured: string[] = []
    const port = new SlackApprovalPort({
      api,
      channel: 'C1',
      onDecision: (d) => captured.push(JSON.stringify(d)),
      log: (m) => captured.push(m)
    })
    const p = port.requestApproval({ ...req, peek: ['Order summary — no secrets here'] })
    await Promise.resolve()
    port.handleInteraction(tap(APPROVE_ACTION_ID))
    await p
    captured.push(JSON.stringify(api.calls.postMessage))
    captured.push(JSON.stringify(api.calls.updateMessage))
    // The port never touches a token; assert no token-shaped material leaks.
    for (const s of captured) {
      expect(s).not.toMatch(/xoxb-|xapp-/)
    }
  })
})
