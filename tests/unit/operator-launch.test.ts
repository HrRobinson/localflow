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
