import type { FlowSummary } from '../../../../shared/flows'
import type { FlowTemplate, FlowTemplateCategory } from '../../../../shared/flow-templates'

interface Props {
  flows: FlowSummary[]
  templates: FlowTemplate[]
  onOpen: (id: string) => void
  onInstantiate: (templateId: string) => void
  onDelete: (id: string) => void
}

const CATEGORY_LABEL: Record<FlowTemplateCategory, string> = {
  ecom: 'Ecom',
  crm: 'CRM',
  custom: 'Custom'
}

// Same card look as Landing's session-template cards — kept consistent so the
// two "start something" surfaces read the same.
const card =
  'bg-surface-raised flex flex-col gap-2 rounded-[10px] border border-white/10 p-3.5 text-left'

/** The "open a flow" + "new from template" surface — shown when no flow is
 *  open, mirroring Landing's role for the environment view. */
export default function FlowList({
  flows,
  templates,
  onOpen,
  onInstantiate,
  onDelete
}: Props): React.JSX.Element {
  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 p-8">
      <section className="flex flex-col gap-3">
        <h1 className="m-0 text-[18px] font-semibold text-gray-100">New from template</h1>
        {templates.length === 0 ? (
          <div className="rounded-md border border-dashed border-white/10 px-4 py-6 text-center text-[13px] text-gray-500">
            No templates available — the built-in set couldn&apos;t be loaded. You can still start a
            blank flow once they return.
          </div>
        ) : (
          <div className="flex flex-wrap gap-2.5">
            {templates.map((t) => (
              <button
                key={t.id}
                className={`flow-template-card ${card} w-[220px] cursor-pointer hover:bg-white/[0.03]`}
                onClick={() => onInstantiate(t.id)}
                data-flow-template={t.id}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-gray-100">{t.name}</span>
                  <span className="rounded bg-white/[0.08] px-1.5 py-px text-[10px] text-gray-400">
                    {CATEGORY_LABEL[t.category]}
                  </span>
                </span>
                <span className="text-[11px] leading-snug text-gray-500">{t.description}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="m-0 text-[15px] font-semibold text-gray-100">Your flows</h2>
        {flows.length === 0 ? (
          <div className="rounded-md border border-dashed border-white/10 px-4 py-10 text-center text-[13px] text-gray-500">
            No flows yet. Pick a template above to drop a trigger, wire an agent, and hand it to the
            engine.
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
      </section>
    </div>
  )
}
