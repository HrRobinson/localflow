import type { PaletteRow } from '../../lib/flow-palette'
import { PALETTE_DND_MIME, type PaletteDragPayload } from './CanvasSurface'

interface Props {
  rows: PaletteRow[]
  /** Click-to-add fallback (deterministic; the CI-friendly add path, §7). */
  onAdd: (row: PaletteRow) => void
}

const SECTION_LABEL: Record<string, string> = {
  builtin: 'Built-in',
  trigger: 'Triggers',
  action: 'Actions'
}

function sectionOf(row: PaletteRow): keyof typeof SECTION_LABEL {
  if (row.integration === undefined) return 'builtin'
  return row.type === 'trigger' ? 'trigger' : 'action'
}

/**
 * Left rail. Renders built-in node rows + integration-sourced trigger/action
 * rows. Each row is BOTH an HTML5 drag source (drop onto the canvas) and a
 * click-to-add button — the click path is what the e2e drives, since pixel drag
 * is historically flaky under Playwright (§7).
 */
export default function NodePalette({ rows, onAdd }: Props): React.JSX.Element {
  const sections: Array<keyof typeof SECTION_LABEL> = ['builtin', 'trigger', 'action']
  return (
    <aside className="bg-sidebar flex w-[180px] flex-none flex-col gap-1 overflow-auto border-r border-white/[0.07] p-2">
      {sections.map((section) => {
        const sectionRows = rows.filter((r) => sectionOf(r) === section)
        if (sectionRows.length === 0) return null
        return (
          <div key={section}>
            <div className="px-1.5 pt-2 pb-1 text-[10px] tracking-[0.06em] text-gray-500 uppercase">
              {SECTION_LABEL[section]}
            </div>
            {sectionRows.map((row) => (
              <button
                key={row.key}
                type="button"
                draggable
                data-palette-key={row.key}
                data-flow-node-type={row.type}
                className="flex w-full cursor-grab items-center gap-2 rounded-md border-0 bg-transparent px-1.5 py-1.5 text-left text-[12px] text-gray-300 hover:bg-white/5 hover:text-white active:cursor-grabbing"
                onClick={() => onAdd(row)}
                onDragStart={(e) => {
                  const payload: PaletteDragPayload = {
                    type: row.type,
                    integration: row.integration,
                    ref: row.ref
                  }
                  e.dataTransfer.setData(PALETTE_DND_MIME, JSON.stringify(payload))
                  e.dataTransfer.effectAllowed = 'move'
                }}
              >
                <span className="min-w-0 flex-1 truncate">{row.label}</span>
                {row.needsSetup && (
                  <span
                    className="h-1.5 w-1.5 flex-none rounded-full bg-yellow-500"
                    title="Integration needs setup"
                  />
                )}
              </button>
            ))}
          </div>
        )
      })}
    </aside>
  )
}
