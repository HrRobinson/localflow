import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import type { FlowNodeType } from '../../../../shared/flows'

/** Data carried on each xyflow node — a PROJECTION of the FlowNode, never the
 *  source of truth (the reducer owns that). */
export interface FlowNodeData extends Record<string, unknown> {
  label: string
  nodeType: FlowNodeType
  integrationLabel?: string
  /** Worst validation severity affecting this node, if any. */
  severity: 'error' | 'warning' | null
  needsSetup: boolean
}

export type FlowRFNode = Node<FlowNodeData, 'flowNode'>

const TYPE_META: Record<FlowNodeType, { glyph: string; tint: string }> = {
  trigger: { glyph: '▶', tint: 'text-idle' },
  agent: { glyph: '✦', tint: 'text-running' },
  action: { glyph: '➜', tint: 'text-working' },
  gate: { glyph: '⏸', tint: 'text-needs-you' },
  router: { glyph: '⤢', tint: 'text-gray-300' }
}

/**
 * One node's visual: type glyph, label, integration badge, and the in/out
 * connection handles. The border speaks the validation state now (and is the
 * slot the phase-2 live-run overlay colors with --working/--needs-you tokens).
 */
export default function FlowNodeCard({ data, selected }: NodeProps<FlowRFNode>): React.JSX.Element {
  const meta = TYPE_META[data.nodeType]
  const border =
    data.severity === 'error'
      ? 'border-red-500/70'
      : data.severity === 'warning'
        ? 'border-yellow-500/60'
        : selected
          ? 'border-white/60'
          : 'border-white/15'
  return (
    <div
      className={`bg-surface-raised min-w-[150px] rounded-md border-2 ${border} px-3 py-2 text-[12px] text-gray-200 shadow-md`}
      data-flow-node-type={data.nodeType}
    >
      <Handle type="target" position={Position.Left} className="!h-2.5 !w-2.5 !bg-gray-400" />
      <div className="flex items-center gap-2">
        <span className={`text-[13px] ${meta.tint}`}>{meta.glyph}</span>
        <span className="font-mono text-[10px] tracking-[0.08em] text-gray-500 uppercase">
          {data.nodeType}
        </span>
        {data.severity && (
          <span
            className={`ml-auto h-2 w-2 flex-none rounded-full ${data.severity === 'error' ? 'bg-red-500' : 'bg-yellow-500'}`}
            title={data.severity === 'error' ? 'Has an error' : 'Has a warning'}
          />
        )}
      </div>
      <div className="mt-1 truncate text-gray-100">{data.label}</div>
      {data.integrationLabel && (
        <div className="mt-0.5 text-[10px] text-gray-500">
          {data.integrationLabel}
          {data.needsSetup && <span className="text-yellow-500"> · needs setup</span>}
        </div>
      )}
      <Handle type="source" position={Position.Right} className="!h-2.5 !w-2.5 !bg-gray-400" />
    </div>
  )
}
