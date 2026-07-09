import { useCallback, useEffect, useState } from 'react'
import type { ActivityEntry, OperatorStatus } from '../../../shared/operator'

interface Props {
  environment: number
}

/**
 * Read-only operator cockpit for one environment: whether an operator is granted
 * / connected, and a rolling action log of the control-API calls it made. The
 * cockpit REFLECTS the operator; it never owns OpenClaw's sessions, and the panes
 * stay human-drivable regardless. Captures (Layer 4) render below the log.
 */
export default function Cockpit({ environment }: Props): React.JSX.Element {
  const [status, setStatus] = useState<OperatorStatus | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    setStatus(await window.localflow.operatorStatus(environment))
  }, [environment])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount / environment change
    void reload()
  }, [reload])

  // Append live activity for THIS environment without a full refetch.
  useEffect(() => {
    return window.localflow.onOperatorActivity((env, entry: ActivityEntry) => {
      if (env !== environment) return
      setStatus((cur) =>
        cur ? { ...cur, connected: true, activity: [...cur.activity, entry].slice(-200) } : cur
      )
    })
  }, [environment])

  const grant = async (): Promise<void> => {
    await window.localflow.grantOperator(environment)
    await reload()
  }
  const revoke = async (): Promise<void> => {
    await window.localflow.revokeOperator(environment)
    await reload()
  }

  const granted = status?.granted ?? false
  const connected = status?.connected ?? false

  return (
    <div className="cockpit-view flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none items-center gap-3 border-b border-white/[0.07] px-3 py-2 text-[12px]">
        <span
          className="operator-status flex items-center gap-2 font-semibold"
          data-connected={connected ? 'true' : 'false'}
        >
          <span
            className={`dot h-2.5 w-2.5 rounded-full ${connected ? 'bg-idle' : granted ? 'bg-needs-you' : 'bg-exited'}`}
          />
          {connected
            ? 'Operator connected'
            : granted
              ? 'Operator granted — not connected'
              : 'No operator'}
          <span className="text-gray-500">· env {environment}</span>
        </span>
        <span className="flex-1" />
        <button
          className="operator-grant-toggle cursor-pointer rounded-md border border-white/10 bg-white/[0.07] px-2.5 py-1 text-gray-200 hover:bg-white/[0.13]"
          onClick={() => void (granted ? revoke() : grant())}
          onMouseDown={(e) => e.preventDefault()}
        >
          {granted ? 'Revoke operator' : 'Let an operator drive this environment'}
        </button>
      </div>
      {status?.endpoint && (
        <div className="px-3 py-1 font-mono text-[11px] text-gray-500">
          endpoint: {status.endpoint}
        </div>
      )}
      <div className="operator-activity min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-[11px]">
        {(status?.activity.length ?? 0) === 0 ? (
          <div className="cockpit-empty text-gray-500">No operator activity yet.</div>
        ) : (
          status?.activity
            .slice()
            .reverse()
            .map((e, i) => (
              <div
                key={i}
                className="activity-entry flex gap-2 py-0.5 text-gray-300"
                data-route={e.route}
              >
                <span className="text-gray-600">{new Date(e.at).toLocaleTimeString()}</span>
                <span className="text-gray-200">{e.route}</span>
                {e.handle && <span className="text-gray-500">{e.handle}</span>}
                {e.detail && <span className="truncate text-gray-500">{e.detail}</span>}
              </div>
            ))
        )}
      </div>
    </div>
  )
}
