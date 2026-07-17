import type { FlowConditionOp, FlowEdge, FlowEdgeCondition, FlowNode } from '../../../../shared/flows'
import { VALID_CONDITION_OPS } from '../../../../shared/flows'
import type { IntegrationId, ResolvedIntegrationDescriptor } from '../../../../shared/integrations'

/** The terminal agents an `agent` node may spawn (OPERATOR_TERMINAL_AGENTS). */
const TERMINAL_AGENTS = ['claude', 'codex', 'gemini'] as const

/** Human labels for the op dropdown, in the pinned op order. */
const OP_LABELS: Record<FlowConditionOp, string> = {
  eq: '= equals',
  ne: '≠ not equals',
  gt: '> greater than',
  gte: '≥ at least',
  lt: '< less than',
  lte: '≤ at most',
  contains: 'contains',
  exists: 'exists',
  truthy: 'is truthy'
}

/** Unary ops test the field alone and ignore `value` (the value input is hidden). */
const UNARY_OPS: ReadonlySet<FlowConditionOp> = new Set<FlowConditionOp>(['exists', 'truthy'])

/** Read a possibly-legacy edge/gate condition into editor fields (legacy
 *  `{ field, equals }` surfaces as op `eq`). */
function readCondition(c: FlowEdge['condition']): {
  field: string
  op: FlowConditionOp
  value: string
} {
  if (!c) return { field: '', op: 'eq', value: '' }
  if ('op' in c) return { field: c.field, op: c.op, value: c.value === undefined ? '' : String(c.value) }
  return { field: c.field, op: 'eq', value: c.equals === undefined ? '' : String(c.equals) }
}

/** Build the canonical new-shape condition, omitting `value` for unary ops. */
function buildCondition(field: string, op: FlowConditionOp, value: string): FlowEdgeCondition {
  return UNARY_OPS.has(op) ? { field, op } : { field, op, value }
}

function OpSelect({
  value,
  testId,
  onChange
}: {
  value: FlowConditionOp
  testId: string
  onChange: (op: FlowConditionOp) => void
}): React.JSX.Element {
  return (
    <select
      className={inputCls}
      value={value}
      data-config-field={testId}
      onChange={(e) => onChange(e.target.value as FlowConditionOp)}
    >
      {VALID_CONDITION_OPS.map((op) => (
        <option key={op} value={op}>
          {OP_LABELS[op]}
        </option>
      ))}
    </select>
  )
}

interface Props {
  node: FlowNode
  registry: ResolvedIntegrationDescriptor[]
  /** Edges leaving this node (router branch conditions). */
  outgoing: FlowEdge[]
  onUpdateConfig: (
    configPatch: Record<string, unknown>,
    fields?: { integration?: IntegrationId; ref?: string }
  ) => void
  onSetEdgeCondition: (edgeId: string, condition: FlowEdgeCondition | undefined) => void
  onOpenIntegrations: () => void
}

const labelCls = 'mb-1 block text-[11px] tracking-[0.04em] text-gray-400 uppercase'
const inputCls =
  'bg-surface w-full rounded border border-white/15 px-2 py-1 text-[12px] text-gray-100 outline-none focus:border-white/40'

export default function NodeConfigPanel({
  node,
  registry,
  outgoing,
  onUpdateConfig,
  onSetEdgeCondition,
  onOpenIntegrations
}: Props): React.JSX.Element {
  return (
    <aside className="bg-sidebar w-[280px] flex-none overflow-auto border-l border-white/[0.07] p-3">
      <div className="mb-3 font-mono text-[10px] tracking-[0.08em] text-gray-500 uppercase">
        {node.type} node
      </div>
      {(node.type === 'trigger' || node.type === 'action') && (
        <IntegrationForm
          node={node}
          registry={registry}
          onUpdateConfig={onUpdateConfig}
          onOpenIntegrations={onOpenIntegrations}
        />
      )}
      {node.type === 'agent' && <AgentForm node={node} onUpdateConfig={onUpdateConfig} />}
      {node.type === 'gate' && <GateForm node={node} onUpdateConfig={onUpdateConfig} />}
      {node.type === 'router' && (
        <RouterForm outgoing={outgoing} onSetEdgeCondition={onSetEdgeCondition} />
      )}
    </aside>
  )
}

function IntegrationForm({
  node,
  registry,
  onUpdateConfig,
  onOpenIntegrations
}: Pick<Props, 'node' | 'registry' | 'onUpdateConfig' | 'onOpenIntegrations'>): React.JSX.Element {
  const descriptor = registry.find((d) => d.id === node.integration)
  const refs = descriptor
    ? node.type === 'trigger'
      ? descriptor.triggers
      : descriptor.actions
    : []
  return (
    <div className="flex flex-col gap-3">
      <div>
        <label className={labelCls}>Integration</label>
        <select
          className={inputCls}
          value={node.integration ?? ''}
          data-config-field="integration"
          onChange={(e) =>
            onUpdateConfig(
              {},
              { integration: (e.target.value || undefined) as IntegrationId, ref: undefined }
            )
          }
        >
          <option value="">— select —</option>
          {registry.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
              {d.status !== 'connected' ? ' (needs setup)' : ''}
            </option>
          ))}
        </select>
      </div>
      {descriptor && (
        <div>
          <label className={labelCls}>{node.type === 'trigger' ? 'Trigger' : 'Action'}</label>
          <select
            className={inputCls}
            value={node.ref ?? ''}
            data-config-field="ref"
            onChange={(e) => onUpdateConfig({}, { ref: e.target.value || undefined })}
          >
            <option value="">— select —</option>
            {refs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
      )}
      {descriptor?.configFields.map((f) =>
        f.secret ? (
          <div key={f.key}>
            <label className={labelCls}>{f.label}</label>
            <div className="flex items-center gap-2 rounded border border-white/10 bg-white/[0.03] px-2 py-1 text-[11px] text-gray-500">
              <span className="flex-1">Managed in Integrations — {descriptor.status}</span>
              <button
                type="button"
                className="cursor-pointer border-0 bg-transparent text-[11px] text-blue-400 hover:text-blue-300"
                onClick={onOpenIntegrations}
              >
                open
              </button>
            </div>
          </div>
        ) : (
          <div key={f.key}>
            <label className={labelCls}>
              {f.label}
              {f.required && <span className="text-yellow-500"> *</span>}
            </label>
            <input
              className={inputCls}
              placeholder={f.placeholder}
              value={typeof node.config[f.key] === 'string' ? (node.config[f.key] as string) : ''}
              data-config-field={f.key}
              onChange={(e) => onUpdateConfig({ [f.key]: e.target.value })}
            />
          </div>
        )
      )}
    </div>
  )
}

function AgentForm({
  node,
  onUpdateConfig
}: Pick<Props, 'node' | 'onUpdateConfig'>): React.JSX.Element {
  const cfg = node.config
  return (
    <div className="flex flex-col gap-3">
      <div>
        <label className={labelCls}>Agent</label>
        <select
          className={inputCls}
          value={typeof cfg.agentId === 'string' ? (cfg.agentId as string) : ''}
          data-config-field="agentId"
          onChange={(e) => onUpdateConfig({ agentId: e.target.value })}
        >
          <option value="">— select —</option>
          {TERMINAL_AGENTS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className={labelCls}>Environment</label>
        <select
          className={inputCls}
          value={typeof cfg.environment === 'number' ? String(cfg.environment) : '1'}
          data-config-field="environment"
          onChange={(e) => onUpdateConfig({ environment: Number(e.target.value) })}
        >
          {Array.from({ length: 9 }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className={labelCls}>Prompt</label>
        <textarea
          className={`${inputCls} min-h-[90px] resize-y`}
          placeholder="What should this agent do?"
          value={typeof cfg.prompt === 'string' ? (cfg.prompt as string) : ''}
          data-config-field="prompt"
          onChange={(e) => onUpdateConfig({ prompt: e.target.value })}
        />
      </div>
    </div>
  )
}

function GateForm({
  node,
  onUpdateConfig
}: Pick<Props, 'node' | 'onUpdateConfig'>): React.JSX.Element {
  const manual = node.config.manual === true || node.config.condition === undefined
  const { field, op, value } = readCondition(node.config.condition as FlowEdge['condition'])
  const setCond = (next: FlowEdgeCondition): void => onUpdateConfig({ condition: next })
  return (
    <div className="flex flex-col gap-3">
      <div>
        <label className={labelCls}>Mode</label>
        <select
          className={inputCls}
          value={manual ? 'manual' : 'condition'}
          data-config-field="mode"
          onChange={(e) =>
            e.target.value === 'manual'
              ? onUpdateConfig({ manual: true, condition: undefined })
              : onUpdateConfig({ manual: false, condition: buildCondition('', 'eq', '') })
          }
        >
          <option value="manual">Manual approval (needs-you)</option>
          <option value="condition">Continue only if…</option>
        </select>
      </div>
      {!manual && (
        <div className="flex flex-col gap-2">
          <input
            className={inputCls}
            placeholder="field"
            value={field}
            data-config-field="gate-field"
            onChange={(e) => setCond(buildCondition(e.target.value, op, value))}
          />
          <OpSelect value={op} testId="gate-op" onChange={(nextOp) => setCond(buildCondition(field, nextOp, value))} />
          {!UNARY_OPS.has(op) && (
            <input
              className={inputCls}
              placeholder="value"
              value={value}
              data-config-field="gate-value"
              onChange={(e) => setCond(buildCondition(field, op, e.target.value))}
            />
          )}
        </div>
      )}
    </div>
  )
}

function RouterForm({
  outgoing,
  onSetEdgeCondition
}: Pick<Props, 'outgoing' | 'onSetEdgeCondition'>): React.JSX.Element {
  if (outgoing.length === 0) {
    return (
      <div className="text-[12px] text-gray-500">
        Draw arrows out of this router first, then set a branch condition on each.
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-3">
      {outgoing.map((e) => {
        const { field, op, value } = readCondition(e.condition)
        return (
          <div key={e.id} className="rounded border border-white/10 p-2">
            <div className="mb-1 text-[11px] text-gray-500">branch → {e.to}</div>
            <div className="flex flex-col gap-2">
              <input
                className={inputCls}
                placeholder="field"
                value={field}
                data-config-field="router-field"
                onChange={(ev) => onSetEdgeCondition(e.id, buildCondition(ev.target.value, op, value))}
              />
              <OpSelect
                value={op}
                testId="router-op"
                onChange={(nextOp) => onSetEdgeCondition(e.id, buildCondition(field, nextOp, value))}
              />
              {!UNARY_OPS.has(op) && (
                <input
                  className={inputCls}
                  placeholder="value"
                  value={value}
                  data-config-field="router-value"
                  onChange={(ev) => onSetEdgeCondition(e.id, buildCondition(field, op, ev.target.value))}
                />
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
