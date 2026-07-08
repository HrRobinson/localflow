import { useEffect, useState } from 'react'
import type { ActivityEntry, SessionInfo } from '../../../shared/types'
import { activityLine, relativeTime, currentStateLine } from '../lib/activity-format'

interface Props {
  sessions: SessionInfo[]
  activeId: string | null
  onOpenSession: (id: string) => void
}

/**
 * The activity feed: a plain-language, glanceable lens over the same hook
 * events that drive the status colors — not a replacement for the terminal
 * (one click away via "open terminal"). The feed itself is main's in-memory
 * ring (activity:get) plus live pushes (activity:event); the persistent header
 * reads the session's live status/needsYouSince from the polled `sessions`
 * prop, so "waiting for N" ticks on the 1s poll.
 */
export default function Activity({ sessions, activeId, onOpenSession }: Props): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(activeId ?? sessions[0]?.id ?? null)
  const [entries, setEntries] = useState<ActivityEntry[]>([])

  // Keep the selection valid as sessions come and go (render-time adjustment,
  // the same pattern Landing/Sidebar use for stale ids).
  const valid = selectedId !== null && sessions.some((s) => s.id === selectedId)
  const currentId = valid ? selectedId : (sessions[0]?.id ?? null)
  if (currentId !== selectedId) setSelectedId(currentId)

  // `now` powers the relative-time stamps and the persistent header's
  // "waiting Nm" span — same 1s ticker precedent as Landing's stats strip
  // (react-hooks/purity forbids Date.now() directly during render).
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [])

  // Load the ring for the selected session and stream new entries for it.
  // Pushed entries UPSERT rather than append: main collapses consecutive
  // identical hook events into one ring row (bumping its `count`) and
  // re-pushes that same row, so a push whose kind+status match the feed's
  // current last row replaces it instead of appearing as a duplicate.
  useEffect(() => {
    // No session to load: leave `entries` as-is (unrendered — the "No
    // sessions yet" branch below takes over when `session` is null; setting
    // state synchronously here would just cascade an extra render).
    if (currentId === null) return
    let cancelled = false
    void window.localflow.getActivity(currentId).then((list) => {
      if (!cancelled) setEntries(list)
    })
    const off = window.localflow.onActivity((id, entry) => {
      if (id !== currentId) return
      setEntries((prev) => {
        const last = prev[prev.length - 1]
        if (last && last.kind === entry.kind && last.status === entry.status) {
          return [...prev.slice(0, -1), entry]
        }
        return [...prev, entry]
      })
    })
    return () => {
      cancelled = true
      off()
    }
  }, [currentId])

  const session = sessions.find((s) => s.id === currentId) ?? null

  if (!session) {
    return (
      <div className="activity mx-auto flex w-full max-w-[720px] flex-1 flex-col gap-4 px-6 py-8">
        <p className="m-0 text-[13px] text-gray-500">No sessions yet.</p>
      </div>
    )
  }

  return (
    <div className="activity mx-auto flex w-full max-w-[720px] flex-1 flex-col gap-4 overflow-auto px-6 py-8 text-left">
      <div className="flex items-center gap-3">
        <select
          className="activity-switcher bg-surface-raised focus:border-working rounded-md border border-white/[0.14] px-2.5 py-2 text-[13px] text-gray-200 outline-none"
          value={session.id}
          onChange={(e) => setSelectedId(e.target.value)}
          aria-label="Session"
        >
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <button
          className="activity-open cursor-pointer rounded-md border border-white/10 bg-white/[0.07] px-3 py-2 text-[13px] text-gray-200 hover:bg-white/[0.13] hover:text-white"
          onClick={() => onOpenSession(session.id)}
          onMouseDown={(e) => e.preventDefault()}
        >
          {session.kind === 'browser' ? 'open browser' : 'open terminal'}
        </button>
      </div>

      <div
        className="activity-current bg-surface-raised rounded-lg border border-white/10 px-4 py-3 text-[15px] text-gray-100"
        data-status={session.status}
      >
        {currentStateLine(session, now)}
      </div>

      {session.kind === 'browser' && (
        <p className="activity-note m-0 text-[13px] text-gray-500">
          Browser panes have no status feed — lifecycle events only.
        </p>
      )}

      <p className="m-0 text-[11px] tracking-[0.06em] text-gray-600 uppercase">
        Activity · since localflow started
      </p>

      {entries.length === 0 ? (
        <p className="m-0 text-[13px] text-gray-500">No activity yet.</p>
      ) : (
        <ul className="flex list-none flex-col gap-1.5 p-0">
          {entries
            .slice()
            .reverse()
            .map((e, i) => (
              <li
                key={entries.length - 1 - i}
                className="activity-line flex items-baseline gap-2 text-[13px] text-gray-200"
              >
                <span>{activityLine(e.kind, e.count)}</span>
                <span className="text-gray-500">· {relativeTime(e.timestamp, now)}</span>
              </li>
            ))}
        </ul>
      )}
    </div>
  )
}
