// THE ONLY MODULE THAT TOUCHES THE CANVAS LIBRARY (@xyflow/react). It is a
// swappable rendering ADAPTER: it renders the FlowGraph as a projection and
// emits interaction intents (move / connect / select / drop) up to FlowCanvas,
// which routes every one of them through the pure reducer. React Flow never owns
// state here — swapping it for a hand-rolled SVG surface would change only this
// file (§3.3, §10.1).
import { useCallback } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  useReactFlow,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  type EdgeChange,
  type NodeTypes
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import FlowNodeCard, { type FlowNodeData, type FlowRFNode } from './FlowNodeCard'
import type { FlowGraph, FlowNodeType, ValidationResult } from '../../../../shared/flows'
import type { IntegrationId } from '../../../../shared/integrations'

/** The drag payload a palette row writes into the HTML5 dataTransfer. */
export interface PaletteDragPayload {
  type: FlowNodeType
  integration?: IntegrationId
  ref?: string
}

export const PALETTE_DND_MIME = 'application/localflow-flow-node'

interface Props {
  graph: FlowGraph
  selectedId: string | null
  validation: ValidationResult
  onMove: (id: string, position: { x: number; y: number }) => void
  onConnect: (from: string, to: string) => void
  onSelect: (id: string | null) => void
  onRemoveNode: (id: string) => void
  onDisconnect: (edgeId: string) => void
  onDropNode: (payload: PaletteDragPayload, position: { x: number; y: number }) => void
  /** Integration label lookup for the node badge. */
  labelFor: (integration: IntegrationId) => string | undefined
  /** Whether a given node's integration still needs setup (badge marker). */
  needsSetup: (integration: IntegrationId) => boolean
}

const nodeTypes: NodeTypes = { flowNode: FlowNodeCard }

function worstSeverityFor(id: string, validation: ValidationResult): 'error' | 'warning' | null {
  let severity: 'error' | 'warning' | null = null
  for (const issue of validation.issues) {
    if (issue.nodeId !== id) continue
    if (issue.severity === 'error') return 'error'
    severity = 'warning'
  }
  return severity
}

function SurfaceInner(props: Props): React.JSX.Element {
  const { graph, selectedId, validation, onMove, onConnect, onSelect, onDropNode } = props
  const { onRemoveNode, onDisconnect } = props
  const { screenToFlowPosition } = useReactFlow()

  const rfNodes: FlowRFNode[] = graph.nodes.map((n) => {
    const data: FlowNodeData = {
      label:
        n.ref ?? (n.type === 'agent' ? 'Agent' : n.type.charAt(0).toUpperCase() + n.type.slice(1)),
      nodeType: n.type,
      integrationLabel: n.integration ? props.labelFor(n.integration) : undefined,
      severity: worstSeverityFor(n.id, validation),
      needsSetup: n.integration ? props.needsSetup(n.integration) : false
    }
    return {
      id: n.id,
      type: 'flowNode',
      position: n.position,
      selected: n.id === selectedId,
      data
    }
  })

  const rfEdges: Edge[] = graph.edges.map((e) => ({
    id: e.id,
    source: e.from,
    target: e.to,
    label: e.condition ? `${e.condition.field} = ${String(e.condition.equals)}` : undefined,
    'data-edge-id': e.id
  }))

  // Translate xyflow node changes into reducer intents. Position changes drive
  // moveNode live (the reducer is cheap); selection drives onSelect. We do NOT
  // apply changes locally — the graph is re-projected from the reducer result.
  const onNodesChange = useCallback(
    (changes: NodeChange<FlowRFNode>[]): void => {
      for (const c of changes) {
        if (c.type === 'position' && c.position) onMove(c.id, c.position)
        else if (c.type === 'select') onSelect(c.selected ? c.id : null)
        else if (c.type === 'remove') onRemoveNode(c.id)
      }
    },
    [onMove, onSelect, onRemoveNode]
  )

  const onEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]): void => {
      for (const c of changes) if (c.type === 'remove') onDisconnect(c.id)
    },
    [onDisconnect]
  )

  const handleConnect = useCallback(
    (c: Connection): void => {
      if (c.source && c.target) onConnect(c.source, c.target)
    },
    [onConnect]
  )

  const onNodeClick = useCallback(
    (_e: React.MouseEvent, node: Node): void => onSelect(node.id),
    [onSelect]
  )

  const onDrop = useCallback(
    (event: React.DragEvent): void => {
      event.preventDefault()
      const raw = event.dataTransfer.getData(PALETTE_DND_MIME)
      if (!raw) return
      let payload: PaletteDragPayload
      try {
        payload = JSON.parse(raw)
      } catch {
        return
      }
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      onDropNode(payload, position)
    },
    [screenToFlowPosition, onDropNode]
  )

  const onDragOver = useCallback((event: React.DragEvent): void => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  return (
    <div className="h-full w-full" data-flow-surface onDrop={onDrop} onDragOver={onDragOver}>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={handleConnect}
        onNodeClick={onNodeClick}
        onPaneClick={() => onSelect(null)}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  )
}

export default function CanvasSurface(props: Props): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <SurfaceInner {...props} />
    </ReactFlowProvider>
  )
}
