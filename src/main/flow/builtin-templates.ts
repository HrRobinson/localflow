// The shipped, in-repo flow templates — config-as-code, exactly like
// `AGENT_PRESETS` (agents.ts) and the integration descriptor defs. Three
// templates, one per category: a blank escape hatch, an Ecom Support Worker,
// and a CRM Lead Worker. Each `graph` is a COMPLETE, valid `FlowGraph` whose
// node/edge/flow ids are TEMPLATE-LOCAL placeholders (`t-*`) — re-minted on
// instantiate (`instantiateTemplate`, flow-reducer.ts).
//
// SECRET HYGIENE: every `config` here is non-secret (a prompt, a router field,
// a gate reason). Never a token/key/password — enforced by the denylist test.
//
// SHIPPABLE vs. FUTURE: `IntegrationId` is `'linear' | 'email' | 'cloud'` today
// — there is NO `'shopify'` yet. So the Ecom template triggers on `email` and
// replies over `email` in its SHIPPABLE form. When the Shopify connector adds
// `'shopify'` to IntegrationId, `t-trigger` becomes
// `integration:'shopify', ref:'order.created'` and the reply/escalate actions
// gain `getOrder`/`refundOrder` — a PURE DATA edit to this constant, no model
// change. The template stays valid against the CURRENT registry until then.
import type { FlowTemplate } from '../../shared/flow-templates'
import type { FlowGraph } from '../../shared/flows'

// --- custom-blank ------------------------------------------------------------
// Zero nodes/edges — identical to `emptyGraph(...)`. Makes "start from scratch"
// one card among the three rather than the only path.
const blankGraph: FlowGraph = {
  id: 't-custom-blank',
  name: 'Blank flow',
  nodes: [],
  edges: []
}

// --- ecom-support ------------------------------------------------------------
// email trigger → agent (classify + draft reply) → router → { reply | gate →
// escalate }. Router/gate edges use the richer FlowEdgeCondition shape
// (`{ field, op, value }`). Shippable on a connected `email` integration today.
const ecomSupportGraph: FlowGraph = {
  id: 't-ecom-support',
  name: 'Ecom Support Worker',
  nodes: [
    {
      id: 't-trigger',
      type: 'trigger',
      integration: 'email',
      ref: 'inbound',
      config: {},
      position: { x: 80, y: 160 }
    },
    {
      id: 't-agent',
      type: 'agent',
      ref: 'claude',
      config: {
        prompt:
          'Read the inbound customer email. Classify it and, if it is a refund request, ' +
          'extract the order total. Draft a friendly reply. Set `refund` true when the ' +
          'customer is asking for a refund, and `order.total` to the order amount in dollars.'
      },
      position: { x: 320, y: 160 }
    },
    { id: 't-router', type: 'router', config: {}, position: { x: 560, y: 160 } },
    {
      id: 't-reply',
      type: 'action',
      integration: 'email',
      ref: 'send',
      config: {},
      position: { x: 800, y: 80 }
    },
    {
      id: 't-gate',
      type: 'gate',
      config: { reason: 'A refund over $100 needs a human to approve before it is sent.' },
      position: { x: 800, y: 260 }
    },
    {
      id: 't-escalate',
      type: 'action',
      integration: 'email',
      ref: 'send',
      config: {},
      position: { x: 1040, y: 260 }
    }
  ],
  edges: [
    { id: 't-e1', from: 't-trigger', to: 't-agent' },
    { id: 't-e2', from: 't-agent', to: 't-router' },
    // Small/no refund → auto-reply.
    {
      id: 't-e3',
      from: 't-router',
      to: 't-reply',
      condition: { field: 'order.total', op: 'lte', value: 100 }
    },
    // Large refund → human approval gate first.
    {
      id: 't-e4',
      from: 't-router',
      to: 't-gate',
      condition: { field: 'order.total', op: 'gt', value: 100 }
    },
    { id: 't-e5', from: 't-gate', to: 't-escalate' }
  ]
}

// --- crm-lead ----------------------------------------------------------------
// linear trigger → agent (triage/enrich) → router → { create/update issue |
// gate → issue }. The Linear pull→work→route→close loop.
const crmLeadGraph: FlowGraph = {
  id: 't-crm-lead',
  name: 'CRM Lead Worker',
  nodes: [
    {
      id: 't-trigger',
      type: 'trigger',
      integration: 'linear',
      ref: 'issue.created',
      config: {},
      position: { x: 80, y: 160 }
    },
    {
      id: 't-agent',
      type: 'agent',
      ref: 'claude',
      config: {
        prompt:
          'Triage the incoming lead/issue. Enrich it with any context you can infer and ' +
          'assess its priority. Set `priority` to "high" for a hot lead, otherwise "normal".'
      },
      position: { x: 320, y: 160 }
    },
    { id: 't-router', type: 'router', config: {}, position: { x: 560, y: 160 } },
    {
      id: 't-close',
      type: 'action',
      integration: 'linear',
      ref: 'issue.update',
      config: {},
      position: { x: 800, y: 80 }
    },
    {
      id: 't-gate',
      type: 'gate',
      config: { reason: 'A high-priority lead needs a human to review before it is actioned.' },
      position: { x: 800, y: 260 }
    },
    {
      id: 't-escalate',
      type: 'action',
      integration: 'linear',
      ref: 'issue.create',
      config: {},
      position: { x: 1040, y: 260 }
    }
  ],
  edges: [
    { id: 't-e1', from: 't-trigger', to: 't-agent' },
    { id: 't-e2', from: 't-agent', to: 't-router' },
    // Normal lead → update the issue directly.
    {
      id: 't-e3',
      from: 't-router',
      to: 't-close',
      condition: { field: 'priority', op: 'ne', value: 'high' }
    },
    // High-priority lead → human review gate first.
    {
      id: 't-e4',
      from: 't-router',
      to: 't-gate',
      condition: { field: 'priority', op: 'eq', value: 'high' }
    },
    { id: 't-e5', from: 't-gate', to: 't-escalate' }
  ]
}

/** The shipped built-in templates (config-as-code, in-repo). */
export const BUILTIN_FLOW_TEMPLATES: FlowTemplate[] = [
  {
    id: 'custom-blank',
    name: 'Blank flow',
    description:
      'Start from an empty canvas — drop a trigger, wire an agent, hand it to the engine.',
    category: 'custom',
    graph: blankGraph
  },
  {
    id: 'ecom-support',
    name: 'Ecom Support Worker',
    description:
      'Triages inbound support email, auto-replies to the routine ones, and routes big refunds to a human.',
    category: 'ecom',
    graph: ecomSupportGraph
  },
  {
    id: 'crm-lead',
    name: 'CRM Lead Worker',
    description:
      'Triages and enriches incoming Linear leads, then routes the hot ones through a human.',
    category: 'crm',
    graph: crmLeadGraph
  }
]

/** Lookup by catalog id (mirrors `presetFor` in agents.ts). */
export function flowTemplateById(id: string): FlowTemplate | undefined {
  return BUILTIN_FLOW_TEMPLATES.find((t) => t.id === id)
}
