import type { FlowSummary } from '../../../../shared/flows'

interface Props {
  flows: FlowSummary[]
  onOpen: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
}

/** The "open a flow" surface — shown when no flow is open, mirroring Landing's
 *  role for the environment view. Empty + inert with no flows (opt-in). */
export default function FlowList({ flows, onOpen, onNew, onDelete }: Props): React.JSX.Element {
  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col gap-3 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-[18px] font-semibold text-gray-100">Flows</h1>
        <button
          className="bg-running/80 hover:bg-running cursor-pointer rounded-md border-0 px-3 py-1.5 text-[13px] text-white"
          onClick={onNew}
          data-flow-new
        >
          New flow
        </button>
      </div>
      {flows.length === 0 ? (
        <div className="rounded-md border border-dashed border-white/10 px-4 py-10 text-center text-[13px] text-gray-500">
          No flows yet. Create one to drop a trigger, wire an agent, and hand it to the engine.
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {flows.map((f) => (
            <div
              key={f.id}
              className="group bg-surface-raised flex items-center gap-3 rounded-md border border-white/[0.07] px-3 py-2.5 hover:border-white/20"
              data-flow-row={f.id}
            >
              <button
                className="min-w-0 flex-1 cursor-pointer border-0 bg-transparent text-left"
                onClick={() => onOpen(f.id)}
              >
                <div className="truncate text-[13px] text-gray-100">{f.name}</div>
                <div className="text-[11px] text-gray-500">
                  {f.nodeCount} node{f.nodeCount === 1 ? '' : 's'} · updated{' '}
                  {new Date(f.updatedAt).toLocaleString()}
                </div>
              </button>
              <button
                className="cursor-pointer border-0 bg-transparent p-1 text-xs text-gray-500 opacity-0 group-hover:opacity-100 hover:text-red-400"
                title="Delete flow"
                onClick={() => onDelete(f.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
