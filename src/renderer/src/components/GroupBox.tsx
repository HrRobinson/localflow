import type { ReactNode } from 'react'
import type { SessionGroup, SessionStatus } from '../../../shared/types'

interface Props {
  group: SessionGroup
  status: SessionStatus
  onAddPane: () => void
  onEnlargeSession: () => void
  // When the group is session-enlarged the enlarge chrome's breadcrumb
  // already names it, and the header's enlarge-click/`+` are inert in that
  // state — so the caller hides this header to avoid showing the group name
  // (and a dead `+`) twice. The grid (non-enlarged) header is unaffected.
  headerHidden?: boolean
  children: ReactNode
}

// UI copy: the group itself is a "session" (onEnlargeSession); the panes it
// contains stay "panes". Wraps the same pane elements the grid would render
// for a solo pane — no changes to TerminalPane/BrowserPane themselves.
export default function GroupBox({
  group,
  status,
  onAddPane,
  onEnlargeSession,
  headerHidden = false,
  children
}: Props): React.JSX.Element {
  return (
    <div className="group-box flex min-h-0 flex-col gap-2">
      {!headerHidden && (
        <div
          className="group-header pane-header flex cursor-pointer items-center gap-2 bg-white/[0.04] px-2.5 py-1 text-xs select-none"
          data-group-id={group.id}
          onClick={onEnlargeSession}
        >
          <span className="group-rollup h-2.5 w-2.5 rounded-full" data-status={status} />
          <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
            {group.name}
          </span>
          <button
            className="group-add-pane cursor-pointer border-0 bg-transparent text-xs text-gray-400 hover:text-white"
            onClick={(e) => {
              // Adding a pane must not also trigger the header's enlarge click.
              e.stopPropagation()
              onAddPane()
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            +
          </button>
        </div>
      )}
      <div className="grid min-h-0 flex-1 grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-2">
        {children}
      </div>
    </div>
  )
}
