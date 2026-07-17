import { describe, it, expect } from 'vitest'
import {
  isFlowTemplate,
  VALID_FLOW_TEMPLATE_CATEGORIES,
  type FlowTemplate
} from '../../src/shared/flow-templates'
import { BUILTIN_FLOW_TEMPLATES, flowTemplateById } from '../../src/main/flow/builtin-templates'
import { isFlowGraph } from '../../src/shared/flows'

// A minimal valid template for the guard tests.
const okTemplate: FlowTemplate = {
  id: 'x',
  name: 'X',
  description: 'x',
  category: 'custom',
  graph: { id: 'g', name: 'G', nodes: [], edges: [] }
}

describe('isFlowTemplate', () => {
  it('accepts a well-formed template', () => {
    expect(isFlowTemplate(okTemplate)).toBe(true)
  })
  it('rejects a non-object', () => {
    expect(isFlowTemplate(null)).toBe(false)
    expect(isFlowTemplate('nope')).toBe(false)
  })
  it('rejects an unknown category', () => {
    expect(isFlowTemplate({ ...okTemplate, category: 'marketing' })).toBe(false)
  })
  it('rejects a missing/invalid graph', () => {
    expect(isFlowTemplate({ ...okTemplate, graph: { id: 'g' } })).toBe(false)
    expect(isFlowTemplate({ ...okTemplate, graph: undefined })).toBe(false)
  })
  it('rejects missing metadata', () => {
    expect(isFlowTemplate({ ...okTemplate, name: undefined })).toBe(false)
    expect(isFlowTemplate({ ...okTemplate, description: 42 })).toBe(false)
  })
})

describe('BUILTIN_FLOW_TEMPLATES — the shipped set', () => {
  it('ships exactly the three expected templates, one per category', () => {
    const ids = BUILTIN_FLOW_TEMPLATES.map((t) => t.id)
    expect(ids).toEqual(['custom-blank', 'ecom-support', 'crm-lead'])
    expect(BUILTIN_FLOW_TEMPLATES.map((t) => t.category)).toEqual(['custom', 'ecom', 'crm'])
  })

  it('every built-in is a structurally valid FlowTemplate + FlowGraph', () => {
    for (const t of BUILTIN_FLOW_TEMPLATES) {
      expect(isFlowTemplate(t), `${t.id} isFlowTemplate`).toBe(true)
      expect(isFlowGraph(t.graph), `${t.id} isFlowGraph`).toBe(true)
      expect(VALID_FLOW_TEMPLATE_CATEGORIES).toContain(t.category)
    }
  })

  it('ids are unique within each template graph and every edge endpoint resolves', () => {
    for (const t of BUILTIN_FLOW_TEMPLATES) {
      const nodeIds = t.graph.nodes.map((n) => n.id)
      expect(new Set(nodeIds).size, `${t.id} unique node ids`).toBe(nodeIds.length)
      const edgeIds = t.graph.edges.map((e) => e.id)
      expect(new Set(edgeIds).size, `${t.id} unique edge ids`).toBe(edgeIds.length)
      const present = new Set(nodeIds)
      for (const e of t.graph.edges) {
        expect(present.has(e.from), `${t.id} edge ${e.id} from`).toBe(true)
        expect(present.has(e.to), `${t.id} edge ${e.id} to`).toBe(true)
      }
    }
  })

  it('the built-in set only references registered integration ids (email/linear/cloud)', () => {
    const known = new Set(['email', 'linear', 'cloud'])
    for (const t of BUILTIN_FLOW_TEMPLATES) {
      for (const n of t.graph.nodes) {
        if (n.integration !== undefined) {
          expect(known.has(n.integration), `${t.id} node ${n.id} integration`).toBe(true)
        }
      }
    }
  })

  it('custom-blank is an empty graph', () => {
    const blank = flowTemplateById('custom-blank')!
    expect(blank.graph.nodes).toEqual([])
    expect(blank.graph.edges).toEqual([])
  })
})

describe('flowTemplateById', () => {
  it('finds a shipped template', () => {
    expect(flowTemplateById('ecom-support')?.name).toBe('Ecom Support Worker')
  })
  it('returns undefined for an unknown id', () => {
    expect(flowTemplateById('nope')).toBeUndefined()
  })
})

describe('no-secret invariant (global secret rule)', () => {
  // A template is shareable JSON: it must carry only integration refs + non-
  // secret config, NEVER a credential. Both the KEY (a config field named like
  // a secret) and the VALUE (a token/key-shaped string) are guarded.
  const SECRET_KEY = /token|secret|password|credential|apikey|api[_-]?key|\bkey\b|bearer|auth/i
  const SECRET_VALUE = /(sk|pk|ghp|gho|xoxb)[-_][A-Za-z0-9]{12,}|-----BEGIN|eyJ[A-Za-z0-9_-]{10,}/

  function scan(value: unknown, path: string): string[] {
    const hits: string[] = []
    if (typeof value === 'string') {
      if (SECRET_VALUE.test(value)) hits.push(`${path}: value looks like a credential`)
      return hits
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (SECRET_KEY.test(k)) hits.push(`${path}.${k}: secret-shaped config key`)
        hits.push(...scan(v, `${path}.${k}`))
      }
    }
    return hits
  }

  it('no built-in template node config carries a secret-shaped key or value', () => {
    const hits: string[] = []
    for (const t of BUILTIN_FLOW_TEMPLATES) {
      for (const n of t.graph.nodes) hits.push(...scan(n.config, `${t.id}/${n.id}/config`))
    }
    expect(hits, hits.join('\n')).toEqual([])
  })

  it('a template with a secret-shaped key is caught by the scan (guard is live)', () => {
    const bad = scan({ apiKey: 'whatever' }, 'x/config')
    expect(bad.length).toBeGreaterThan(0)
  })
})
