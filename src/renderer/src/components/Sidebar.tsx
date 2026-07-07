import Brand from './Brand'
import type { SessionInfo } from '../../../shared/types'

interface Props {
  sessions: SessionInfo[]
  view: 'home' | 'terminals' | 'settings'
  activeId: string | null
  onHome: () => void
  onTerminals: () => void
  onSettings: () => void
  onOpenSession: (id: string) => void
}

const navItemBase =
  'cursor-pointer rounded-md border-0 bg-transparent px-2.5 py-[7px] text-left text-[13px] text-gray-400 hover:bg-white/5 hover:text-white disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-gray-400'
const navItemActive = 'bg-white/[0.08] font-semibold text-white'

export default function Sidebar({
  sessions,
  view,
  activeId,
  onHome,
  onTerminals,
  onSettings,
  onOpenSession
}: Props): React.JSX.Element {
  return (
    <aside className="bg-sidebar flex min-h-0 w-[230px] flex-none flex-col border-r border-white/[0.07]">
      <div className="flex items-center gap-[9px] px-4 pt-4 pb-2.5">
        <Brand />
        <span className="font-mono text-[13px] font-semibold tracking-[0.02em] text-gray-200">
          localflow
        </span>
      </div>
      <nav className="flex flex-col gap-0.5 p-2">
        <button
          className={`${navItemBase}${view === 'home' ? ` ${navItemActive}` : ''}`}
          onClick={onHome}
          onMouseDown={(e) => e.preventDefault()}
        >
          Overview
        </button>
        <button
          className={`${navItemBase}${view === 'terminals' ? ` ${navItemActive}` : ''}`}
          onClick={onTerminals}
          disabled={sessions.length === 0}
          onMouseDown={(e) => e.preventDefault()}
        >
          Terminals
        </button>
        <button
          className={`${navItemBase}${view === 'settings' ? ` ${navItemActive}` : ''}`}
          onClick={onSettings}
          onMouseDown={(e) => e.preventDefault()}
        >
          Settings
        </button>
      </nav>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        <div className="px-2.5 pt-2 pb-1 text-[11px] tracking-[0.06em] text-gray-500 uppercase">
          Sessions
        </div>
        {sessions.length === 0 && (
          <div className="px-2.5 py-0.5 text-xs text-gray-600">none yet</div>
        )}
        {sessions.map((s) => (
          <button
            key={s.id}
            className={`side-session flex w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2.5 py-1.5 text-left text-[13px] text-gray-300 hover:bg-white/5 hover:text-white ${activeId === s.id && view === 'terminals' ? 'active bg-white/10 text-white' : ''}`}
            data-nav-session={s.id}
            title={s.cwd}
            onClick={() => onOpenSession(s.id)}
            onMouseDown={(e) => e.preventDefault()}
          >
            <span className="dot bg-exited h-2 w-2 flex-none rounded-full" data-status={s.status} />
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">
              {s.cwd.split('/').filter(Boolean).pop() ?? s.cwd}
            </span>
          </button>
        ))}
        <button
          className="block w-full cursor-pointer rounded-md border-0 bg-transparent px-2.5 py-1.5 text-left text-[13px] text-gray-500 hover:bg-white/5 hover:text-gray-300"
          onClick={onHome}
          onMouseDown={(e) => e.preventDefault()}
        >
          + new session
        </button>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1.5 border-t border-white/[0.07] px-4 py-3 text-[11px] text-gray-400">
        <span className="flex items-center gap-1.5">
          <span className="bg-working h-[9px] w-[9px] rounded-full" /> working
        </span>
        <span className="flex items-center gap-1.5">
          <span className="bg-needs-you h-[9px] w-[9px] rounded-full" /> needs you
        </span>
        <span className="flex items-center gap-1.5">
          <span className="bg-idle h-[9px] w-[9px] rounded-full" /> done
        </span>
        <span className="flex items-center gap-1.5">
          <span className="bg-running h-[9px] w-[9px] rounded-full" /> running
        </span>
      </div>
    </aside>
  )
}
