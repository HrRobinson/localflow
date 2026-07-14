import { useEffect } from 'react'
import type { SessionGroup } from '../../../shared/types'

interface Props {
  groups: SessionGroup[]
  onPick: (groupId: string | 'new') => void
  onCancel: () => void
}

// Minimal modal: one row per candidate session (group) plus a "New
// session…" row that wraps the pane in a freshly named group. Same
// backdrop/Escape-cancel/z-layer conventions as AddPanePicker (Task 8).
// Callers filter `groups` down to the current environment and exclude the
// pane's own current group before rendering this.
export default function GroupPicker({ groups, onPick, onCancel }: Props): React.JSX.Element {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  return (
    <div
      className="group-picker fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onMouseDown={onCancel}
    >
      <div
        className="bg-surface-raised flex w-[360px] flex-col gap-3 rounded-md border border-white/[0.14] p-4"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3 className="m-0 text-[13px] font-semibold text-gray-200">Move pane into session</h3>
        <div className="flex flex-col gap-1.5">
          {[...groups]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((group) => (
              <button
                key={group.id}
                className="pick-group cursor-pointer rounded-md border border-white/10 bg-white/[0.07] px-2.5 py-1.5 text-left text-[13px] text-gray-200 hover:bg-white/[0.13]"
                data-group-id={group.id}
                onClick={() => onPick(group.id)}
                onMouseDown={(e) => e.stopPropagation()}
              >
                {group.name}
              </button>
            ))}
          <button
            className="pick-new-group cursor-pointer rounded-md border border-white/10 bg-white/[0.07] px-2.5 py-1.5 text-left text-[13px] text-gray-200 hover:bg-white/[0.13]"
            onClick={() => onPick('new')}
            onMouseDown={(e) => e.stopPropagation()}
          >
            New session…
          </button>
        </div>
        <button
          className="group-picker-cancel cursor-pointer self-end border-0 bg-transparent text-xs text-gray-400 hover:text-white"
          onClick={onCancel}
          onMouseDown={(e) => e.stopPropagation()}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
