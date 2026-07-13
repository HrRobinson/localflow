import { describe, it, expect } from 'vitest'
import { parseSessionTemplates } from '../../src/shared/templates'

describe('parseSessionTemplates', () => {
  it('parses a valid template with terminal and browser panes', () => {
    const result = parseSessionTemplates([
      {
        name: 'fullstack',
        panes: [
          { kind: 'terminal', agentId: 'codex' },
          { kind: 'browser', url: 'localhost:5173' }
        ]
      }
    ])
    expect(result).toEqual([
      {
        name: 'fullstack',
        panes: [
          { kind: 'terminal', agentId: 'codex' },
          { kind: 'browser', url: 'localhost:5173' }
        ]
      }
    ])
  })

  it('skips a pane entry with a bad kind, keeping the rest of the template', () => {
    const result = parseSessionTemplates([
      {
        name: 'mixed',
        panes: [{ kind: 'bogus' }, { kind: 'terminal', agentId: 'claude' }]
      }
    ])
    expect(result).toEqual([{ name: 'mixed', panes: [{ kind: 'terminal', agentId: 'claude' }] }])
  })

  it('skips a browser pane missing url', () => {
    const result = parseSessionTemplates([
      {
        name: 'no-url',
        panes: [{ kind: 'browser' }, { kind: 'terminal', agentId: 'claude' }]
      }
    ])
    expect(result).toEqual([{ name: 'no-url', panes: [{ kind: 'terminal', agentId: 'claude' }] }])
  })

  it('defaults a terminal pane with no agentId to claude', () => {
    const result = parseSessionTemplates([{ name: 'solo', panes: [{ kind: 'terminal' }] }])
    expect(result).toEqual([{ name: 'solo', panes: [{ kind: 'terminal', agentId: 'claude' }] }])
  })

  it('returns [] for a non-array input', () => {
    expect(parseSessionTemplates(undefined)).toEqual([])
    expect(parseSessionTemplates(null)).toEqual([])
    expect(parseSessionTemplates({})).toEqual([])
    expect(parseSessionTemplates('nope')).toEqual([])
  })

  it('skips a whole template that ends up with zero valid panes', () => {
    const result = parseSessionTemplates([
      { name: 'empty', panes: [{ kind: 'browser' }, { kind: 'bogus' }] },
      { name: 'kept', panes: [{ kind: 'terminal', agentId: 'shell' }] }
    ])
    expect(result).toEqual([{ name: 'kept', panes: [{ kind: 'terminal', agentId: 'shell' }] }])
  })

  it('skips malformed template entries (missing/blank name, non-array panes)', () => {
    const result = parseSessionTemplates([
      { panes: [{ kind: 'terminal' }] },
      { name: '   ', panes: [{ kind: 'terminal' }] },
      { name: 'no-panes-field' },
      { name: 'valid', panes: [{ kind: 'terminal' }] }
    ])
    expect(result).toEqual([{ name: 'valid', panes: [{ kind: 'terminal', agentId: 'claude' }] }])
  })

  it('rejects an unknown agentId rather than silently defaulting it', () => {
    const result = parseSessionTemplates([
      {
        name: 'weird-agent',
        panes: [{ kind: 'terminal', agentId: 'not-a-real-agent' }, { kind: 'terminal' }]
      }
    ])
    expect(result).toEqual([
      { name: 'weird-agent', panes: [{ kind: 'terminal', agentId: 'claude' }] }
    ])
  })
})
