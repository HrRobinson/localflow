import { useEffect, useMemo, useRef, useState } from 'react'
import CanvasSurface, { type PaletteDragPayload } from './flow/CanvasSurface'
import NodePalette from './flow/NodePalette'
import NodeConfigPanel from './flow/NodeConfigPanel'
import FlowToolbar from './flow/FlowToolbar'
import FlowList from './flow/FlowList'
import { buildPalette, type PaletteRow } from '../lib/flow-palette'
import { validateFlow } from '../lib/flow-validate'
import {
  addNode,
  connect,
  disconnect,
  emptyGraph,
  instantiateTemplate,
  makeIdFn,
  moveNode,
  removeNode,
  renameFlow,
  setEdgeCondition,
  updateNodeConfig
} from '../lib/flow-reducer'
import type { FlowGraph, FlowSummary } from '../../../shared/flows'
import type { FlowTemplate } from '../../../shared/flow-templates'
import type { IntegrationId, ResolvedIntegrationDescriptor } from '../../../shared/integrations'

/**
 * The Flow Canvas view container. Owns the in-memory editor state (current
 * FlowGraph, selected node, dirty flag) and wires palette + surface + config
 * panel + toolbar. It is the ONE stateful component: every graph mutation goes
 * through the pure reducer, and CanvasSurface is a projection of the result.
 */
export default function FlowCanvas(): React.JSX.Element {
  const [registry, setRegistry] = useState<ResolvedIntegrationDescriptor[]>([])
  const [flows, setFlows] = useState<FlowSummary[]>([])
  const [templates, setTemplates] = useState<FlowTemplate[]>([])
  const [graph, setGraph] = useState<FlowGraph | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  // Injected id sources — deterministic in tests (the SessionManager clock
  // pattern); here just monotonic so ids never collide within a session.
  const nodeIds = useRef(makeIdFn('fn'))
  const edgeIds = useRef(makeIdFn('fe'))
  const flowIds = useRef(makeIdFn('flow'))

  useEffect(() => {
    void window.saiife.listIntegrationDescriptors().then(setRegistry)
    void window.saiife.listFlows().then(setFlows)
    // The built-in templates are a constant read; a failure just leaves the
    // picker empty (the blank-flow path via custom-blank is unaffected once it
    // returns), so we note it rather than bricking the canvas.
    void window.saiife
      .listFlowTemplates()
      .then(setTemplates)
      .catch(() =>
        setNotice("Couldn't load the starter templates — you can still open your saved flows.")
      )
  }, [])

  // A later flow-save failure is pushed here (mirrors persistence notices).
  useEffect(() => {
    return window.saiife.onFlowPersistenceNotice((message) => setNotice(message))
  }, [])

  const palette = useMemo(() => buildPalette(registry), [registry])
  const validation = useMemo(
    () => validateFlow(graph ?? { id: '', name: '', nodes: [], edges: [] }, registry),
    [graph, registry]
  )

  const labelFor = (id: IntegrationId): string | undefined =>
    registry.find((d) => d.id === id)?.label
  const needsSetup = (id: IntegrationId): boolean =>
    (registry.find((d) => d.id === id)?.status ?? 'needs-config') !== 'connected'

  const apply = (next: FlowGraph): void => {
    setGraph(next)
    setDirty(true)
  }

  const refreshList = (): void => {
    void window.saiife.listFlows().then(setFlows)
  }

  const newFlow = (): void => {
    setGraph(emptyGraph(flowIds.current(), 'Untitled flow'))
    setSelectedId(null)
    setDirty(true)
  }

  // Clone a template into a fresh, unsaved draft and open it on the canvas —
  // identical to `openFlow` but dirty (not yet on disk). Ids are re-minted and
  // config deep-cloned by the pure `instantiateTemplate`; a template node on an
  // unconnected integration surfaces through the SAME needsSetup/validation
  // path as a dragged-in node — it loads/edits fine, and only Run is refused.
  const instantiate = (templateId: string): void => {
    const template = templates.find((t) => t.id === templateId)
    if (!template) {
      setNotice("That template couldn't be found — it may no longer be available.")
      return
    }
    setGraph(
      instantiateTemplate(template, {
        flowId: flowIds.current(),
        nodeIdFn: nodeIds.current,
        edgeIdFn: edgeIds.current,
        existingNames: flows.map((f) => f.name)
      })
    )
    setSelectedId(null)
    setDirty(true)
  }

  const openFlow = (id: string): void => {
    void window.saiife.getFlow(id).then((g) => {
      if (!g) {
        setNotice("That flow couldn't be opened — it may have been deleted or is unreadable.")
        refreshList()
        return
      }
      setGraph(g)
      setSelectedId(null)
      setDirty(false)
    })
  }

  const backToList = (): void => {
    setGraph(null)
    setSelectedId(null)
    refreshList()
  }

  const deleteFlow = (id: string): void => {
    void window.saiife.deleteFlow(id).then(refreshList)
  }

  const nextPosition = (): { x: number; y: number } => {
    const n = graph?.nodes.length ?? 0
    return { x: 140 + (n % 5) * 48, y: 120 + (n % 5) * 40 }
  }

  const addFromPalette = (row: PaletteRow): void => {
    if (!graph) return
    apply(
      addNode(
        graph,
        { type: row.type, integration: row.integration, ref: row.ref, position: nextPosition() },
        nodeIds.current
      )
    )
  }

  const dropNode = (payload: PaletteDragPayload, position: { x: number; y: number }): void => {
    if (!graph) return
    apply(
      addNode(
        graph,
        { type: payload.type, integration: payload.integration, ref: payload.ref, position },
        nodeIds.current
      )
    )
  }

  const save = async (): Promise<FlowGraph | null> => {
    if (!graph) return null
    const res = await window.saiife.saveFlow(graph)
    if (res.ok) {
      setDirty(false)
      refreshList()
      return graph
    }
    setNotice(res.error)
    return null
  }

  const run = async (): Promise<void> => {
    // Save-then-run: the engine always executes PERSISTED truth (§4.1).
    const saved = await save()
    if (!saved) return
    const res = await window.saiife.runFlow(saved.id)
    setNotice(
      res.ok
        ? `Flow handed to the engine — run ${res.runId} started.`
        : `Couldn't run this flow — ${res.error}`
    )
  }

  const selectedNode = graph?.nodes.find((n) => n.id === selectedId) ?? null

  if (!graph) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {notice && <Banner message={notice} onDismiss={() => setNotice(null)} />}
        <FlowList
          flows={flows}
          templates={templates}
          onOpen={openFlow}
          onInstantiate={instantiate}
          onDelete={deleteFlow}
        />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {notice && <Banner message={notice} onDismiss={() => setNotice(null)} />}
      <FlowToolbar
        name={graph.name}
        dirty={dirty}
        validation={validation}
        onRename={(name) => apply(renameFlow(graph, name))}
        onSave={() => void save()}
        onRun={() => void run()}
        onNew={newFlow}
        onBack={backToList}
      />
      <div className="flex min-h-0 flex-1">
        <NodePalette rows={palette} onAdd={addFromPalette} />
        <div className="min-w-0 flex-1">
          <CanvasSurface
            graph={graph}
            selectedId={selectedId}
            validation={validation}
            onMove={(id, position) => apply(moveNode(graph, id, position))}
            onConnect={(from, to) => apply(connect(graph, from, to, edgeIds.current))}
            onSelect={setSelectedId}
            onRemoveNode={(id) => {
              apply(removeNode(graph, id))
              if (selectedId === id) setSelectedId(null)
            }}
            onDisconnect={(edgeId) => apply(disconnect(graph, edgeId))}
            onDropNode={dropNode}
            labelFor={labelFor}
            needsSetup={needsSetup}
          />
        </div>
        {selectedNode && (
          <NodeConfigPanel
            node={selectedNode}
            registry={registry}
            outgoing={graph.edges.filter((e) => e.from === selectedNode.id)}
            onUpdateConfig={(patch, fields) =>
              apply(updateNodeConfig(graph, selectedNode.id, patch, fields))
            }
            onSetEdgeCondition={(edgeId, condition) =>
              apply(setEdgeCondition(graph, edgeId, condition))
            }
            onOpenIntegrations={() =>
              setNotice(
                'The Integrations Hub isn’t available yet — secret credentials will be managed there once it ships.'
              )
            }
          />
        )}
      </div>
    </div>
  )
}

function Banner({
  message,
  onDismiss
}: {
  message: string
  onDismiss: () => void
}): React.JSX.Element {
  return (
    <div className="flow-notice flex items-center gap-3 border-b border-yellow-500/40 bg-yellow-500/10 px-3 py-1.5 text-[12px] text-yellow-200">
      <span className="flex-1">{message}</span>
      <button
        className="cursor-pointer border-0 bg-transparent text-yellow-200/70 hover:text-white"
        onClick={onDismiss}
      >
        dismiss
      </button>
    </div>
  )
}
