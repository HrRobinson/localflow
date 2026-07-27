import { useEffect, useState } from 'react'
import { HTTP_METHODS } from '../../../shared/api-client'
import type { CollectionView, CollectionRequest } from '../../../shared/api-client'

type HttpMethod = (typeof HTTP_METHODS)[number]

// Reused verbatim from Settings.tsx so this reads as native saiife.
const card =
  'bg-surface-raised flex flex-col gap-2.5 rounded-[10px] border border-white/10 p-3.5 text-left'
const rowBtn =
  'cursor-pointer rounded-md border border-white/10 bg-white/[0.07] px-2.5 py-1 text-xs text-gray-300 hover:bg-white/[0.13] hover:text-white'
const inputCls =
  'bg-surface rounded-md border border-white/[0.14] px-2.5 py-1.5 font-mono text-[11px] text-gray-200 outline-none focus:border-white/40'

interface Props {
  environment: number
}

/**
 * Curate the API-client collections an agent can be granted against, for one
 * environment. A collection owns its origins, auth config, credential (keychain,
 * write-only), varSets and saved requests. The credential value is never read
 * back — the view carries only `hasSecret`. Granting access lives in the Cockpit.
 */
export default function ApiClient({ environment }: Props): React.JSX.Element {
  const [collections, setCollections] = useState<CollectionView[] | null>(null)
  const [creating, setCreating] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const reload = (): void => {
    void window.saiife.listCollections(environment).then(setCollections)
  }
  useEffect(() => {
    let cancelled = false
    void window.saiife.listCollections(environment).then((c) => {
      if (!cancelled) setCollections(c)
    })
    return () => {
      cancelled = true
    }
  }, [environment])

  const remove = (id: string): void => {
    void window.saiife.removeCollection(environment, id).then((res) => {
      if (!res.ok) setNotice(res.reason)
      else reload()
    })
  }

  return (
    <div className="api-client-view mx-auto flex w-full max-w-[720px] flex-1 flex-col items-stretch gap-7 overflow-auto px-6 py-8 text-left">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <h3 className="m-0 text-[15px] font-semibold tracking-[-0.01em]">API client</h3>
          <p className="m-0 text-[13px] text-gray-500">
            Collections an agent can be granted to send against · env {environment}
          </p>
        </div>
        <button
          className={`api-client-new ${rowBtn}`}
          onClick={() => setCreating(true)}
          onMouseDown={(e) => e.preventDefault()}
        >
          New collection
        </button>
      </div>

      {creating && (
        <NewCollection
          environment={environment}
          onDone={() => {
            setCreating(false)
            reload()
          }}
          onCancel={() => setCreating(false)}
          onError={setNotice}
        />
      )}

      {collections === null ? (
        <p className="text-[13px] text-gray-500">Loading collections…</p>
      ) : collections.length === 0 && !creating ? (
        <p className="text-[13px] text-gray-500">No collections yet.</p>
      ) : (
        collections.map((c) => (
          <section key={c.id} className={`api-client-panel ${card}`} data-collection={c.id}>
            <div className="flex items-center gap-2">
              <span className="flex-1 font-semibold">{c.name}</span>
              {c.allowLocal && <span className="text-needs-you text-[11px]">local ok</span>}
              <button
                className={`api-collection-delete ${rowBtn}`}
                onClick={() => remove(c.id)}
                onMouseDown={(e) => e.preventDefault()}
              >
                Delete
              </button>
            </div>
            <div className="font-mono text-[11px] text-gray-500">{c.origins.join(', ')}</div>
            <div className="text-[12px] text-gray-400">
              auth: {c.auth.scheme}
              {c.auth.secretRef ? ` · ${c.auth.secretRef}` : ''} ·{' '}
              {c.hasSecret ? 'credential set' : 'no credential'}
            </div>
            {c.auth.scheme !== 'none' && c.auth.secretRef && (
              <SecretField collection={c} onChanged={reload} onError={setNotice} />
            )}
            <VarSetEditor collection={c} onChanged={reload} onError={setNotice} />
            <RequestEditor collection={c} onChanged={reload} onError={setNotice} />
          </section>
        ))
      )}

      {notice && <p className="api-client-notice m-0 text-[12px] text-red-400">{notice}</p>}
    </div>
  )
}

function NewCollection({
  environment,
  onDone,
  onCancel,
  onError
}: {
  environment: number
  onDone: () => void
  onCancel: () => void
  onError: (reason: string) => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [origins, setOrigins] = useState('')
  const [scheme, setScheme] = useState('bearer')
  const [secretRef, setSecretRef] = useState('')
  const [header, setHeader] = useState('')
  const [allowLocal, setAllowLocal] = useState(false)

  const save = (): void => {
    const auth =
      scheme === 'none'
        ? { scheme: 'none' }
        : scheme === 'header'
          ? { scheme, secretRef, header }
          : { scheme, secretRef }
    const collection = {
      name,
      origins: origins
        .split(',')
        .map((o) => o.trim())
        .filter((o) => o.length > 0),
      auth,
      allowLocal,
      varSets: {},
      requests: []
    }
    void window.saiife.upsertCollection(environment, collection).then((res) => {
      if (!res.ok) onError(res.reason)
      else onDone()
    })
  }

  return (
    <section className={`api-client-new-panel ${card}`}>
      <input
        className={`api-collection-name ${inputCls}`}
        placeholder="name, e.g. Stripe"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        className={`api-collection-origins ${inputCls}`}
        placeholder="origins, comma-separated — https://api.stripe.com"
        value={origins}
        onChange={(e) => setOrigins(e.target.value)}
      />
      <div className="flex items-center gap-2">
        <select
          className={`api-collection-scheme ${inputCls}`}
          value={scheme}
          onChange={(e) => setScheme(e.target.value)}
        >
          <option value="bearer">bearer</option>
          <option value="basic">basic</option>
          <option value="header">header</option>
          <option value="none">none</option>
        </select>
        {scheme !== 'none' && (
          <input
            className={`api-collection-secretref ${inputCls} flex-1`}
            placeholder="secretRef — keychain field name, NOT the secret"
            value={secretRef}
            onChange={(e) => setSecretRef(e.target.value)}
          />
        )}
        {scheme === 'header' && (
          <input
            className={`api-collection-header ${inputCls}`}
            placeholder="header, e.g. X-API-Key"
            value={header}
            onChange={(e) => setHeader(e.target.value)}
          />
        )}
      </div>
      <label className="flex items-center gap-2 text-[12px] text-gray-400">
        <input
          type="checkbox"
          className="api-collection-allowlocal"
          checked={allowLocal}
          onChange={(e) => setAllowLocal(e.target.checked)}
        />
        Allow loopback/LAN targets (localhost) — bypasses the SSRF guard for this collection's
        origins
      </label>
      <div className="flex gap-2">
        <button
          className={`api-collection-save ${rowBtn}`}
          onClick={save}
          onMouseDown={(e) => e.preventDefault()}
          disabled={name.length === 0}
        >
          Save
        </button>
        <button className={rowBtn} onClick={onCancel} onMouseDown={(e) => e.preventDefault()}>
          Cancel
        </button>
      </div>
    </section>
  )
}

/**
 * A SECRET field: write-only. Modeled verbatim on Integrations.tsx's SecretField
 * — the value is never read back, `collection.hasSecret` replaces it. Saving
 * sends the value inbound; the response echoes nothing.
 */
function SecretField({
  collection,
  onChanged,
  onError
}: {
  collection: CollectionView
  onChanged: () => void
  onError: (reason: string) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(!collection.hasSecret)
  const [value, setValue] = useState('')
  const secretRef = collection.auth.secretRef ?? ''

  const save = (): void => {
    void window.saiife
      .setCollectionSecret(collection.environment, collection.id, secretRef, value)
      .then((res) => {
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
    void window.saiife
      .clearCollectionSecret(collection.environment, collection.id, secretRef)
      .then((res) => {
        if (!res.ok) onError(res.reason)
        else onChanged()
      })
  }

  return (
    <div className="flex flex-col gap-1 border-t border-white/10 pt-2.5 text-[12px] text-gray-400">
      {collection.hasSecret && !editing ? (
        <div className="flex items-center gap-2">
          <span className="api-secret-set text-idle font-mono text-[12px]">•••• set</span>
          <button
            type="button"
            className={`api-secret-replace ${rowBtn}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setEditing(true)}
          >
            Replace
          </button>
          <button
            type="button"
            className={`api-secret-clear ${rowBtn}`}
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
            className={`api-secret flex-1 ${inputCls}`}
            placeholder="paste the credential — stored in the keychain, never shown again"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <button
            type="button"
            className={`api-secret-save ${rowBtn}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={save}
            disabled={value.length === 0}
          >
            Save
          </button>
          {collection.hasSecret && (
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
    </div>
  )
}

/**
 * Editable named varSets: key/value rows per set, add/remove rows and sets.
 * Every edit persists the whole collection via `upsertCollection` (same `id`,
 * so it updates in place rather than minting a new collection).
 *
 * `varSets` is a LOCAL buffer (seeded from `collection.varSets`, not read from
 * the prop thereafter) rather than deriving each mutation straight off
 * `collection`: the prop only refreshes after an async `upsertCollection` +
 * `listCollections` round trip, so a button clicked right after typing (before
 * that round trip lands) would otherwise compute its own persist off a stale
 * snapshot that never saw the just-typed edit — losing it even though the
 * edit's own persist call went out first. Updating this buffer synchronously
 * in `persist` (and via `onChange` for the value field) means a same-tick
 * button click always closes over the freshest local state instead.
 */
function VarSetEditor({
  collection,
  onChanged,
  onError
}: {
  collection: CollectionView
  onChanged: () => void
  onError: (reason: string) => void
}): React.JSX.Element {
  // Seeded once from the prop, then authoritative on its own — the parent's
  // `<section key={c.id}>` remounts this component (fresh state, fresh seed)
  // whenever `collection` starts describing a different id, so there is no
  // later point where re-seeding from the prop is both safe and needed.
  const [varSets, setVarSets] = useState(collection.varSets)

  const [newSetName, setNewSetName] = useState('')

  const persist = (nextVarSets: Record<string, Record<string, string>>): void => {
    setVarSets(nextVarSets)
    void window.saiife
      .upsertCollection(collection.environment, { ...collection, varSets: nextVarSets })
      .then((res) => {
        if (!res.ok) onError(res.reason)
        else onChanged()
      })
  }

  const addSet = (): void => {
    const trimmed = newSetName.trim()
    if (trimmed.length === 0 || varSets[trimmed]) return
    setNewSetName('')
    persist({ ...varSets, [trimmed]: {} })
  }
  const renameSet = (oldName: string, nextName: string): void => {
    const trimmed = nextName.trim()
    if (trimmed.length === 0 || trimmed === oldName) return
    if (varSets[trimmed]) {
      onError(`A varSet named "${trimmed}" already exists — pick another name.`)
      return
    }
    const next = { ...varSets }
    next[trimmed] = next[oldName]
    delete next[oldName]
    persist(next)
  }
  const removeSet = (setName: string): void => {
    const next = { ...varSets }
    delete next[setName]
    persist(next)
  }
  const addVar = (setName: string): void => {
    persist({ ...varSets, [setName]: { ...varSets[setName], '': '' } })
  }
  const renameVar = (setName: string, oldKey: string, nextKey: string): void => {
    const trimmed = nextKey.trim()
    if (trimmed.length === 0 || trimmed === oldKey) return
    if (varSets[setName][trimmed]) {
      onError(`Variable "${trimmed}" already exists in "${setName}" — pick another name.`)
      return
    }
    const vars = { ...varSets[setName] }
    vars[trimmed] = vars[oldKey]
    delete vars[oldKey]
    persist({ ...varSets, [setName]: vars })
  }
  const setVarValue = (setName: string, key: string, value: string): void => {
    persist({ ...varSets, [setName]: { ...varSets[setName], [key]: value } })
  }
  const removeVar = (setName: string, key: string): void => {
    const vars = { ...varSets[setName] }
    delete vars[key]
    persist({ ...varSets, [setName]: vars })
  }

  return (
    <div className="flex flex-col gap-2 border-t border-white/10 pt-2.5">
      <span className="text-[12px] font-semibold text-gray-300">Variable sets</span>
      {Object.entries(varSets).map(([setName, vars]) => (
        <div key={setName} className="flex flex-col gap-1.5 pl-1">
          <div className="flex items-center gap-2">
            <input
              className={`api-varset-name ${inputCls}`}
              defaultValue={setName}
              onBlur={(e) => renameSet(setName, e.target.value)}
            />
            <button className={`api-varset-add-var ${rowBtn}`} onClick={() => addVar(setName)}>
              Add variable
            </button>
            <button className={`api-varset-remove ${rowBtn}`} onClick={() => removeSet(setName)}>
              Remove set
            </button>
          </div>
          {Object.entries(vars).map(([key, value]) => (
            <div key={key} className="flex items-center gap-2 pl-3">
              <input
                className={`api-var-key ${inputCls}`}
                defaultValue={key}
                onBlur={(e) => renameVar(setName, key, e.target.value)}
              />
              <input
                className={`api-var-value flex-1 ${inputCls}`}
                value={value}
                onChange={(e) =>
                  setVarSets((cur) => ({
                    ...cur,
                    [setName]: { ...cur[setName], [key]: e.target.value }
                  }))
                }
                onBlur={(e) => setVarValue(setName, key, e.target.value)}
              />
              <button
                className={`api-var-remove ${rowBtn}`}
                onClick={() => removeVar(setName, key)}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      ))}
      <div className="flex items-center gap-2">
        <input
          className={`api-varset-name ${inputCls}`}
          placeholder="new varSet name, e.g. live"
          value={newSetName}
          onChange={(e) => setNewSetName(e.target.value)}
        />
        <button
          className={`api-varset-new ${rowBtn}`}
          onClick={addSet}
          disabled={newSetName.trim().length === 0}
        >
          New varSet
        </button>
      </div>
    </div>
  )
}

/**
 * Editable saved requests: name, method, path per row, add/remove. Persists
 * the same way as `VarSetEditor` — the whole collection via `upsertCollection`,
 * off a local `requests` buffer for the same reason (see `VarSetEditor`'s doc
 * comment): a button clicked right after typing must never race the prop's
 * async refresh and drop the edit.
 */
function RequestEditor({
  collection,
  onChanged,
  onError
}: {
  collection: CollectionView
  onChanged: () => void
  onError: (reason: string) => void
}): React.JSX.Element {
  // See `VarSetEditor`'s comment on `varSets`: seeded once, then authoritative.
  const [requests, setRequests] = useState(collection.requests)

  const persist = (nextRequests: CollectionRequest[]): void => {
    setRequests(nextRequests)
    void window.saiife
      .upsertCollection(collection.environment, { ...collection, requests: nextRequests })
      .then((res) => {
        if (!res.ok) onError(res.reason)
        else onChanged()
      })
  }

  const addRequest = (): void => {
    const request: CollectionRequest = {
      id: crypto.randomUUID(),
      name: 'New request',
      method: 'GET',
      path: '/'
    }
    persist([...requests, request])
  }
  const updateRequest = (id: string, patch: Partial<CollectionRequest>): void => {
    persist(requests.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }
  const removeRequest = (id: string): void => {
    persist(requests.filter((r) => r.id !== id))
  }
  const editRequest = (id: string, patch: Partial<CollectionRequest>): void => {
    setRequests((cur) => cur.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

  return (
    <div className="flex flex-col gap-2 border-t border-white/10 pt-2.5">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[12px] font-semibold text-gray-300">Saved requests</span>
        <button className={`api-request-new ${rowBtn}`} onClick={addRequest}>
          New request
        </button>
      </div>
      {requests.map((r) => (
        <div key={r.id} className="flex items-center gap-2">
          <input
            className={`api-request-name flex-1 ${inputCls}`}
            value={r.name}
            onChange={(e) => editRequest(r.id, { name: e.target.value })}
            onBlur={(e) => updateRequest(r.id, { name: e.target.value })}
          />
          <select
            className={`api-request-method ${inputCls}`}
            value={r.method}
            onChange={(e) => updateRequest(r.id, { method: e.target.value as HttpMethod })}
          >
            {HTTP_METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <input
            className={`api-request-path flex-1 ${inputCls}`}
            value={r.path}
            onChange={(e) => editRequest(r.id, { path: e.target.value })}
            onBlur={(e) => updateRequest(r.id, { path: e.target.value })}
          />
          <button className={`api-request-remove ${rowBtn}`} onClick={() => removeRequest(r.id)}>
            Remove
          </button>
        </div>
      ))}
    </div>
  )
}
