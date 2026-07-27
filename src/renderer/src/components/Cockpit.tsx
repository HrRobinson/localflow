import { useCallback, useEffect, useState } from 'react'
import {
  CAPTURE_KINDS,
  type ActivityEntry,
  type Capture,
  type CaptureKind,
  type OperatorStatus,
  type Watchpoint
} from '../../../shared/operator'
import type { SessionInfo } from '../../../shared/types'
import type { ApiGrantStatus, CollectionView } from '../../../shared/api-client'

interface Props {
  environment: number
  sessions: SessionInfo[]
}

/**
 * Read-only operator cockpit for one environment: whether an operator is granted
 * / connected, and a rolling action log of the control-API calls it made. The
 * cockpit REFLECTS the operator; it never owns OpenClaw's sessions, and the panes
 * stay human-drivable regardless. Captures (Layer 4) render below the log.
 */
export default function Cockpit({ environment, sessions }: Props): React.JSX.Element {
  const [status, setStatus] = useState<OperatorStatus | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    setStatus(await window.saiife.operatorStatus(environment))
  }, [environment])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount / environment change
    void reload()
  }, [reload])

  // Append live activity for THIS environment without a full refetch.
  useEffect(() => {
    return window.saiife.onOperatorActivity((env, entry: ActivityEntry) => {
      if (env !== environment) return
      setStatus((cur) =>
        cur ? { ...cur, connected: true, activity: [...cur.activity, entry].slice(-200) } : cur
      )
    })
  }, [environment])

  const [captures, setCaptures] = useState<Capture[]>([])
  const [watchpoints, setWatchpoints] = useState<Watchpoint[]>([])

  const reloadSub = useCallback(async (): Promise<void> => {
    const [c, w] = await Promise.all([
      window.saiife.listCaptures(environment),
      window.saiife.listWatchpoints(environment)
    ])
    setCaptures(c)
    setWatchpoints(w)
  }, [environment])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount / environment change
    void reloadSub()
    const iv = setInterval(() => void reloadSub(), 2000)
    return () => clearInterval(iv)
  }, [reloadSub])

  // Watchpoint-register form: workflow + step labels plus the capture kinds.
  // Registration goes through the same WatchpointRegistry validation as the
  // control API's POST /watchpoints (malformed fields come back null).
  const [wpWorkflow, setWpWorkflow] = useState('')
  const [wpStep, setWpStep] = useState('')
  const [wpKinds, setWpKinds] = useState<CaptureKind[]>(['envelope'])

  const toggleKind = (kind: CaptureKind): void =>
    setWpKinds((cur) => (cur.includes(kind) ? cur.filter((k) => k !== kind) : [...cur, kind]))

  const registerWatchpoint = async (): Promise<void> => {
    const wp = await window.saiife.registerWatchpoint(
      environment,
      wpWorkflow.trim(),
      wpStep.trim(),
      wpKinds
    )
    if (!wp) return
    setWpWorkflow('')
    setWpStep('')
    await reloadSub()
  }

  const grant = async (): Promise<void> => {
    await window.saiife.grantOperator(environment)
    await reload()
  }
  const revoke = async (): Promise<void> => {
    await window.saiife.revokeOperator(environment)
    await reload()
  }

  const granted = status?.granted ?? false
  const connected = status?.connected ?? false

  const [apiStatus, setApiStatus] = useState<ApiGrantStatus | null>(null)
  const [apiCollections, setApiCollections] = useState<CollectionView[]>([])
  const [pickedCollections, setPickedCollections] = useState<string[]>([])
  const [pickedPane, setPickedPane] = useState('')
  const [apiNotice, setApiNotice] = useState<string | null>(null)

  const reloadApi = useCallback(async (): Promise<void> => {
    setApiStatus(await window.saiife.apiGrantStatus(environment))
    setApiCollections(await window.saiife.listCollections(environment))
  }, [environment])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount / environment change
    void reloadApi()
  }, [reloadApi])

  const apiGranted = apiStatus?.granted ?? false
  const apiPaneName =
    sessions.find((s) => s.id === apiStatus?.paneId)?.name ?? apiStatus?.paneId ?? ''
  const pickedPaneName = sessions.find((s) => s.id === pickedPane)?.name

  const grantApi = async (): Promise<void> => {
    const res = await window.saiife.grantApiAccess(environment, pickedPane, pickedCollections)
    if (!res.ok) setApiNotice(res.reason)
    else {
      setApiNotice(null)
      await reloadApi()
    }
  }
  const revokeApi = async (): Promise<void> => {
    await window.saiife.revokeApiAccess(environment)
    await reloadApi()
  }

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
      <div className="api-access flex flex-none flex-col gap-2 border-b border-white/[0.07] px-3 py-2 text-[12px]">
        <div className="flex items-center gap-2">
          <span className="api-status font-semibold">
            {apiGranted
              ? `API granted · ${apiStatus?.collectionIds?.length ?? 0} collection(s)` +
                (apiPaneName ? ` · ${apiPaneName}` : '')
              : 'No API grant'}
          </span>
          <span className="text-gray-500">· env {environment}</span>
        </div>
        {apiGranted ? (
          <button
            className="api-grant-toggle self-start rounded-md border border-white/10 bg-white/[0.07] px-2.5 py-1 text-gray-200 hover:bg-white/[0.13]"
            onClick={() => void revokeApi()}
            onMouseDown={(e) => e.preventDefault()}
          >
            Revoke API access
          </button>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <select
              multiple
              className="api-collection-select bg-surface rounded-md border border-white/[0.14] px-2 py-1 text-[11px]"
              value={pickedCollections}
              onChange={(e) =>
                setPickedCollections([...e.target.selectedOptions].map((o) => o.value))
              }
            >
              {apiCollections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <select
              className="api-pane-select bg-surface rounded-md border border-white/[0.14] px-2 py-1 text-[11px]"
              value={pickedPane}
              onChange={(e) => setPickedPane(e.target.value)}
            >
              <option value="">choose a pane…</option>
              {sessions
                .filter((s) => s.environment === environment && s.kind === 'terminal')
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
            <button
              className="api-grant-toggle rounded-md border border-white/10 bg-white/[0.07] px-2.5 py-1 text-gray-200 hover:bg-white/[0.13] disabled:opacity-40"
              onClick={() => void grantApi()}
              onMouseDown={(e) => e.preventDefault()}
              disabled={pickedPane === '' || pickedCollections.length === 0}
            >
              {pickedPaneName
                ? `Grant API access (restarts ${pickedPaneName})`
                : 'Grant API access (restarts the pane)'}
            </button>
          </div>
        )}
        {apiNotice && <span className="api-notice text-red-400">{apiNotice}</span>}
      </div>
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
      <div className="watchpoints-list flex-none border-t border-white/[0.07] px-3 py-2 text-[11px]">
        <div className="mb-1 font-semibold text-gray-300">Watchpoints</div>
        <div className="watchpoint-form mb-1 flex flex-wrap items-center gap-2">
          <input
            className="watchpoint-workflow w-28 rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-gray-200 outline-none focus:border-white/40"
            placeholder="workflow"
            value={wpWorkflow}
            onChange={(e) => setWpWorkflow(e.target.value)}
          />
          <input
            className="watchpoint-step w-28 rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-gray-200 outline-none focus:border-white/40"
            placeholder="step"
            value={wpStep}
            onChange={(e) => setWpStep(e.target.value)}
          />
          {CAPTURE_KINDS.map((kind) => (
            <label
              key={kind}
              className="watchpoint-kind flex cursor-pointer items-center gap-1 text-gray-400"
              data-kind={kind}
            >
              <input
                type="checkbox"
                checked={wpKinds.includes(kind)}
                onChange={() => toggleKind(kind)}
              />
              {kind}
            </label>
          ))}
          <button
            className="watchpoint-register cursor-pointer rounded border border-white/10 bg-white/[0.07] px-1.5 text-gray-200 hover:bg-white/[0.13] disabled:cursor-default disabled:opacity-40 disabled:hover:bg-white/[0.07]"
            disabled={wpWorkflow.trim() === '' || wpStep.trim() === '' || wpKinds.length === 0}
            onClick={() => void registerWatchpoint()}
            onMouseDown={(e) => e.preventDefault()}
          >
            Register
          </button>
        </div>
        {watchpoints.length === 0 ? (
          <div className="text-gray-500">No watchpoints registered.</div>
        ) : (
          watchpoints.map((w) => (
            <div
              key={w.id}
              className="watchpoint-row flex gap-2 py-0.5 text-gray-300"
              data-watchpoint-id={w.id}
              data-hit={w.hit ? 'true' : 'false'}
            >
              <span className="text-gray-200">{w.workflow}</span>
              <span className="text-gray-500">@ {w.step}</span>
              <span className="text-gray-600">{w.capture.join(',')}</span>
              <span className={w.hit ? 'text-idle' : 'text-gray-500'}>
                {w.hit ? 'hit' : 'pending'}
              </span>
            </div>
          ))
        )}
      </div>
      <div className="captures-list flex-none border-t border-white/[0.07] px-3 py-2 text-[11px]">
        <div className="mb-1 font-semibold text-gray-300">Captures</div>
        {captures.length === 0 ? (
          <div className="text-gray-500">No captures yet.</div>
        ) : (
          captures
            .slice()
            .reverse()
            .map((c) => (
              <div
                key={c.id}
                className={`capture-row flex items-center gap-2 py-0.5 text-gray-300 ${c.halted ? 'halted' : ''}`}
                data-capture-id={c.id}
              >
                <span className="text-gray-600">{new Date(c.createdAt).toLocaleTimeString()}</span>
                {c.screenshotPath && (
                  <span className="truncate text-gray-500">{c.screenshotPath}</span>
                )}
                {c.output && <span className="text-gray-500">{c.output.length} lines</span>}
                {c.halted ? (
                  <>
                    <button
                      className="capture-resume text-idle cursor-pointer rounded border border-white/10 px-1.5"
                      onClick={() =>
                        void window.saiife.resumeCapture(environment, c.id, true).then(reloadSub)
                      }
                      onMouseDown={(e) => e.preventDefault()}
                    >
                      Resume
                    </button>
                    <button
                      className="capture-stop cursor-pointer rounded border border-white/10 px-1.5 text-gray-400"
                      onClick={() =>
                        void window.saiife.resumeCapture(environment, c.id, false).then(reloadSub)
                      }
                      onMouseDown={(e) => e.preventDefault()}
                    >
                      Stop
                    </button>
                  </>
                ) : (
                  <span className="text-gray-600">stored</span>
                )}
              </div>
            ))
        )}
      </div>
    </div>
  )
}
