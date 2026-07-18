// Flow templates — the get-started layer over the Flow Builder. A FlowTemplate
// IS a seed `FlowGraph` (the pinned cross-project contract, `flows.ts`) plus
// catalog metadata; instantiating one is a deep-clone with fresh ids
// (`instantiateTemplate`, flow-reducer.ts). No I/O here — this module is
// imported by BOTH main (the built-in set) and the renderer (the picker), the
// same `flows.ts` / `templates.ts` discipline.
//
// SECRET HYGIENE (global rule): a FlowTemplate is shareable JSON. It carries
// only integration REFS (`integration: IntegrationId`, `ref: string`) and
// non-secret node `config` — NEVER a credential. Secrets live only in the
// Integrations Hub keychain (`safeStorage`). A denylist test enforces this on
// the shipped set (tests/unit/flow-templates.test.ts).
import type { FlowGraph } from './flows'
import { isFlowGraph } from './flows'

/** A catalog category for the picker's grouping/badges. */
export type FlowTemplateCategory = 'ecom' | 'crm' | 'custom'

/** Every `FlowTemplateCategory`, for validating catalog data at the boundary. */
export const VALID_FLOW_TEMPLATE_CATEGORIES: FlowTemplateCategory[] = ['ecom', 'crm', 'custom']

/**
 * A pre-authored starter flow. `graph` is a COMPLETE, structurally valid
 * FlowGraph (isFlowGraph === true) whose ids are TEMPLATE-LOCAL placeholders —
 * they are re-minted on instantiate, never persisted as-is. Carries only
 * integration refs + non-secret node config; NEVER a credential.
 */
export interface FlowTemplate {
  /** Stable catalog id (e.g. 'ecom-support'), NOT the instantiated flow id. */
  id: string
  /** Card title, e.g. "Ecom Support Worker". */
  name: string
  /** One-line card subtitle — what the worker does, in plain language. */
  description: string
  category: FlowTemplateCategory
  /** The seed graph. Its `graph.id`/`graph.name` are placeholders. */
  graph: FlowGraph
}

/**
 * True when `x` is a structurally valid `FlowTemplate`: catalog metadata is
 * well-typed, `category` is known, and `graph` is a valid `FlowGraph`. Mirrors
 * `isFlowGraph`; used by the validation test and any future import path.
 */
export function isFlowTemplate(x: unknown): x is FlowTemplate {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  return (
    typeof o.id === 'string' &&
    typeof o.name === 'string' &&
    typeof o.description === 'string' &&
    typeof o.category === 'string' &&
    VALID_FLOW_TEMPLATE_CATEGORIES.includes(o.category as FlowTemplateCategory) &&
    isFlowGraph(o.graph)
  )
}
