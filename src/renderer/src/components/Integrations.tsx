import { useEffect, useState } from 'react'
import type {
  IntegrationFieldView,
  IntegrationId,
  IntegrationStatus,
  IntegrationView
} from '../../../shared/integrations'

// Reused verbatim from Settings.tsx so this reads as native localflow.
const card =
  'bg-surface-raised flex flex-col gap-2.5 rounded-[10px] border border-white/10 p-3.5 text-left'
const rowBtn =
  'cursor-pointer rounded-md border border-white/10 bg-white/[0.07] px-2.5 py-1 text-xs text-gray-300 hover:bg-white/[0.13] hover:text-white'
const inputCls =
  'bg-surface rounded-md border border-white/[0.14] px-2.5 py-1.5 font-mono text-[11px] text-gray-200 outline-none focus:border-white/40'

// The Cockpit status-dot mapping (state → dot color), applied to the pill.
const STATUS: Record<IntegrationStatus, { dot: string; label: string }> = {
  connected: { dot: 'bg-idle', label: 'Connected' },
  'needs-config': { dot: 'bg-needs-you', label: 'Needs config' },
  error: { dot: 'bg-exited', label: 'Error' },
  // Configured but turned off — a muted dot, distinct from 'needs-config' (which
  // is actionable-incomplete) and 'connected'.
  disabled: { dot: 'bg-gray-500', label: 'Disabled' }
}

function StatusPill({ view }: { view: IntegrationView }): React.JSX.Element {
  const s = STATUS[view.status]
  return (
    <span
      className="integration-status flex items-center gap-2 text-[12px] font-semibold text-gray-300"
      data-status={view.status}
      title={view.statusDetail}
    >
      <span className={`dot h-2.5 w-2.5 flex-none rounded-full ${s.dot}`} />
      {s.label}
    </span>
  )
}

/** A NON-secret config field: uncontrolled text saved on blur (Settings idiom). */
function ConfigField({
  id,
  field,
  onSaved,
  onError
}: {
  id: IntegrationId
  field: IntegrationFieldView
  onSaved: (view: IntegrationView) => void
  onError: (reason: string) => void
}): React.JSX.Element {
  return (
    <label className="flex flex-col gap-1 text-[12px] text-gray-400">
      {field.label}
      {field.required && <span className="text-gray-500"> (required)</span>}
      <input
        className={`integration-field ${inputCls}`}
        data-field={field.key}
        placeholder={field.placeholder}
        defaultValue={field.value ?? ''}
        onBlur={(e) => {
          void window.localflow.setIntegrationField(id, field.key, e.target.value).then((res) => {
            if (res.ok) onSaved(res.view)
            else onError(res.reason)
          })
        }}
      />
    </label>
  )
}

/**
 * A SECRET field: write-only. The value is never read back — the view carries
 * only `hasValue`, so a stored secret renders a "•••• set" affordance + Replace/
 * Clear, and an empty masked box otherwise. Submitting sends the value inbound;
 * the response echoes nothing.
 */
function SecretField({
  id,
  field,
  onChanged,
  onError
}: {
  id: IntegrationId
  field: IntegrationFieldView
  onChanged: () => void
  onError: (reason: string) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(!field.hasValue)
  const [value, setValue] = useState('')

  const save = (): void => {
    void window.localflow.setIntegrationSecret(id, field.key, value).then((res) => {
      if (!res.ok) {
        onError(res.reason)
        return
      }
      setValue('')
      setEditing(false)
      onChanged()
    })
  }
  const clear = (): void => {
    void window.localflow.clearIntegrationSecret(id, field.key).then((res) => {
      if (!res.ok) onError(res.reason)
      else onChanged()
    })
  }

  return (
    <label className="flex flex-col gap-1 text-[12px] text-gray-400">
      {field.label}
      {field.required && <span className="text-gray-500"> (required)</span>}
      {field.hasValue && !editing ? (
        <div className="flex items-center gap-2">
          <span className="text-idle font-mono text-[12px]">•••• set</span>
          <button
            type="button"
            className={`integration-secret-replace ${rowBtn}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setEditing(true)}
          >
            Replace
          </button>
          <button
            type="button"
            className={`integration-secret-clear ${rowBtn}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={clear}
          >
            Clear
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <input
            type="password"
            className={`integration-secret flex-1 ${inputCls}`}
            data-field={field.key}
            placeholder="paste the secret — stored in the keychain, never shown again"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <button
            type="button"
            className={`integration-secret-save ${rowBtn}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={save}
            disabled={value.length === 0}
          >
            Save
          </button>
          {field.hasValue && (
            <button
              type="button"
              className={rowBtn}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setValue('')
                setEditing(false)
              }}
            >
              Cancel
            </button>
          )}
        </div>
      )}
    </label>
  )
}

export default function Integrations(): React.JSX.Element {
  const [views, setViews] = useState<IntegrationView[] | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const reload = (): void => {
    void window.localflow.listIntegrations().then(setViews)
  }
  useEffect(() => {
    let cancelled = false
    void window.localflow.listIntegrations().then((v) => {
      if (!cancelled) setViews(v)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const replaceView = (view: IntegrationView): void =>
    setViews((prev) => (prev ? prev.map((v) => (v.id === view.id ? view : v)) : prev))

  const toggleEnabled = async (id: IntegrationId, next: boolean): Promise<void> => {
    const previous = views
    // Optimistic, like Settings' togglePack — a rejected write rolls back rather
    // than lying that it's on.
    setViews((prev) => (prev ? prev.map((v) => (v.id === id ? { ...v, enabled: next } : v)) : prev))
    setNotice(null)
    const res = await window.localflow.setIntegrationEnabled(id, next)
    if (res.ok) replaceView(res.view)
    else {
      setViews(previous)
      setNotice(`Couldn't ${next ? 'enable' : 'disable'} ${id}: ${res.reason}`)
    }
  }

  return (
    <div className="integrations-view mx-auto flex w-full max-w-[720px] flex-1 flex-col items-stretch gap-7 overflow-auto px-6 py-8 text-left">
      <section className="flex flex-col gap-2">
        <h3 className="m-0 text-[15px] font-semibold tracking-[-0.01em]">Integrations</h3>
        <p className="m-0 text-[13px] text-gray-500">
          Enable an integration, provide its config, and see its live connection status. Secret
          fields are written only to your OS keychain and are never shown again. No live connection
          is made yet — this stores and validates credentials.
        </p>
      </section>

      {views === null && <p className="m-0 text-[13px] text-gray-400">Loading integrations…</p>}

      {views?.map((view) => (
        <section key={view.id} className={`integration-panel ${card}`} data-integration={view.id}>
          <div className="flex flex-row items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="text-sm font-semibold">{view.label}</span>
              <StatusPill view={view} />
            </div>
            <label className="flex items-center gap-2 text-[12px] text-gray-400">
              <input
                type="checkbox"
                className="integration-enabled"
                checked={view.enabled}
                onChange={(e) => void toggleEnabled(view.id, e.target.checked)}
              />
              Enabled
            </label>
          </div>

          {view.status === 'error' && view.statusDetail && (
            <p className="integration-error m-0 text-[11px] text-red-400">{view.statusDetail}</p>
          )}
          {view.status === 'needs-config' && view.statusDetail && (
            <p className="m-0 text-[11px] text-yellow-400/80">{view.statusDetail}</p>
          )}

          <div className="flex flex-col gap-2.5">
            {view.fields.map((field) =>
              field.secret ? (
                <SecretField
                  key={field.key}
                  id={view.id}
                  field={field}
                  onChanged={reload}
                  onError={setNotice}
                />
              ) : (
                <ConfigField
                  key={field.key}
                  id={view.id}
                  field={field}
                  onSaved={replaceView}
                  onError={setNotice}
                />
              )
            )}
          </div>
        </section>
      ))}

      {notice && <p className="integrations-notice m-0 text-[12px] text-red-400">{notice}</p>}
    </div>
  )
}
