import { describe, it, expect } from 'vitest'
import { buildPalette } from '../../src/renderer/src/lib/flow-palette'
import type { ResolvedIntegrationDescriptor } from '../../src/shared/integrations'

const registry: ResolvedIntegrationDescriptor[] = [
  {
    id: 'linear',
    label: 'Linear',
    configFields: [],
    triggers: [{ id: 'issue.created', label: 'Issue created' }],
    actions: [{ id: 'issue.create', label: 'Create issue' }],
    status: 'connected'
  },
  {
    id: 'cloud',
    label: 'Cloud',
    configFields: [],
    triggers: [], // action-only integration
    actions: [{ id: 'run.deploy', label: 'Deploy service' }],
    status: 'needs-config'
  }
]

describe('flow-palette', () => {
  it('emits the three built-in node rows (agent/gate/router) with no integration', () => {
    const p = buildPalette([])
    const builtins = p.filter((r) => r.integration === undefined)
    expect(builtins.map((r) => r.type)).toEqual(['agent', 'gate', 'router'])
    expect(builtins.every((r) => r.ref === undefined)).toBe(true)
  })

  it('emits one trigger row per descriptor trigger and one action row per action', () => {
    const p = buildPalette(registry)
    const triggers = p.filter((r) => r.type === 'trigger')
    const actions = p.filter((r) => r.type === 'action')
    expect(triggers).toHaveLength(1) // only linear has a trigger
    expect(triggers[0]).toMatchObject({
      type: 'trigger',
      integration: 'linear',
      ref: 'issue.created',
      integrationLabel: 'Linear'
    })
    expect(actions.map((r) => r.ref)).toEqual(['issue.create', 'run.deploy'])
  })

  it('marks rows of a not-connected integration as needsSetup, connected ones not', () => {
    const p = buildPalette(registry)
    const linearAction = p.find((r) => r.ref === 'issue.create')!
    const cloudAction = p.find((r) => r.ref === 'run.deploy')!
    expect(linearAction.needsSetup).toBe(false)
    expect(cloudAction.needsSetup).toBe(true)
  })

  it('built-in rows are never marked needsSetup', () => {
    const p = buildPalette(registry)
    expect(p.filter((r) => r.integration === undefined).every((r) => r.needsSetup === false)).toBe(
      true
    )
  })

  it('gives every row a stable unique key', () => {
    const p = buildPalette(registry)
    const keys = p.map((r) => r.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
