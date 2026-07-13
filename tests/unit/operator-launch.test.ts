import { describe, it, expect } from 'vitest'
import { credentialEnv, OperatorLaunchTracker } from '../../src/main/operator-launch'

describe('credentialEnv', () => {
  it('flattens a grant to the shipped skill env vars', () => {
    expect(credentialEnv('http://127.0.0.1:5000', 'tok')).toEqual({
      LOCALFLOW_ENDPOINT: 'http://127.0.0.1:5000',
      LOCALFLOW_TOKEN: 'tok'
    })
  })
})

describe('OperatorLaunchTracker', () => {
  it('revokes a launch-created grant when its last session closes', () => {
    const t = new OperatorLaunchTracker()
    t.onLaunch(1, 's1', false) // launch created the grant on env 1
    expect(t.trackedIds()).toEqual(['s1'])
    expect(t.onClose('s1')).toBe(1)
  })

  it('does NOT revoke a pre-existing grant', () => {
    const t = new OperatorLaunchTracker()
    t.onLaunch(2, 's1', true) // env 2 was already granted
    expect(t.onClose('s1')).toBeNull()
  })

  it('revokes only after the LAST launched session in the env closes', () => {
    const t = new OperatorLaunchTracker()
    t.onLaunch(1, 's1', false)
    t.onLaunch(1, 's2', true) // second launch reuses the existing grant
    expect(t.onClose('s1')).toBeNull() // s2 still live
    expect(t.onClose('s2')).toBe(1) // last one closes → revoke
  })

  it('returns null for an unknown session', () => {
    expect(new OperatorLaunchTracker().onClose('nope')).toBeNull()
  })
})

describe('OperatorLaunchTracker.onPtyExit', () => {
  const dead = (): boolean => false

  it('flag OFF: never revokes on pty exit (default behavior)', () => {
    const t = new OperatorLaunchTracker()
    t.onLaunch(1, 's1', false)
    expect(t.onPtyExit('s1', dead, false)).toBeNull()
    // Ownership is untouched — deletion still revokes as before.
    expect(t.onClose('s1')).toBe(1)
  })

  it('flag ON: revokes a launch-owned env when its last live pty exits', () => {
    const t = new OperatorLaunchTracker()
    t.onLaunch(1, 's1', false)
    expect(t.onPtyExit('s1', dead, true)).toBe(1)
    // Ownership was consumed: the later deletion must not revoke again (a
    // grant made manually in the meantime belongs to the user).
    expect(t.onClose('s1')).toBeNull()
  })

  it('flag ON: does not revoke while another launched session is live', () => {
    const t = new OperatorLaunchTracker()
    t.onLaunch(1, 's1', false)
    t.onLaunch(1, 's2', true)
    expect(t.onPtyExit('s1', (id) => id === 's2', true)).toBeNull()
    expect(t.onPtyExit('s2', dead, true)).toBe(1)
  })

  it('flag ON: never revokes a grant the launch did not create', () => {
    const t = new OperatorLaunchTracker()
    t.onLaunch(2, 's1', true) // env 2 was already granted
    expect(t.onPtyExit('s1', dead, true)).toBeNull()
  })

  it('flag ON: unknown sessions are ignored', () => {
    expect(new OperatorLaunchTracker().onPtyExit('nope', dead, true)).toBeNull()
  })
})

describe('OperatorLaunchTracker restart re-grant', () => {
  it('re-launch after a revoke restores ownership for the same session', () => {
    const t = new OperatorLaunchTracker()
    t.onLaunch(1, 's1', false)
    // Grant revoked out from under the session (cockpit toggle or
    // operatorRevokeOnExit); the restart path re-grants and re-registers with
    // wasGrantedBefore=false — the restart created the new grant, so it owns
    // the eventual revoke again.
    expect(t.onPtyExit('s1', () => false, true)).toBe(1)
    t.onLaunch(1, 's1', false)
    expect(t.trackedIds()).toEqual(['s1']) // no duplicate tracking
    expect(t.onClose('s1')).toBe(1)
  })

  it('restart of a reuse-launched session that re-grants takes ownership', () => {
    const t = new OperatorLaunchTracker()
    t.onLaunch(2, 's1', true) // launched into a manually-granted env
    // Manual revoke, then restart: env is ungranted, so the restart grants
    // it (wasGrantedBefore=false) and now owns it.
    t.onLaunch(2, 's1', false)
    expect(t.onClose('s1')).toBe(2)
  })
})
