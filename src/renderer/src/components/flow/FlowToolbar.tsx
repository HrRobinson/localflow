import { useState } from 'react'
import type { ValidationResult } from '../../../../shared/flows'

interface Props {
  name: string
  dirty: boolean
  validation: ValidationResult
  onRename: (name: string) => void
  onSave: () => void
  onRun: () => void
  onNew: () => void
  onBack: () => void
}

/** Top bar: flow name (rename), Save, Run, New, back-to-list, and a validation
 *  summary chip. Run is disabled while the graph has any `error` (§5). */
export default function FlowToolbar({
  name,
  dirty,
  validation,
  onRename,
  onSave,
  onRun,
  onNew,
  onBack
}: Props): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  const errors = validation.issues.filter((i) => i.severity === 'error').length
  const warnings = validation.issues.filter((i) => i.severity === 'warning').length

  const btn =
    'cursor-pointer rounded-md border-0 px-3 py-1 text-[12px] disabled:cursor-default disabled:opacity-40'

  return (
    <div className="flex items-center gap-2 border-b border-white/[0.07] bg-white/[0.03] px-3 py-2">
      <button
        className="cursor-pointer border-0 bg-transparent text-[12px] text-gray-400 hover:text-white"
        onClick={onBack}
      >
        ‹ Flows
      </button>
      {editing ? (
        <input
          autoFocus
          className="bg-surface min-w-0 rounded border border-white/20 px-2 py-1 text-[13px] text-gray-100 outline-none"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            setEditing(false)
            const t = draft.trim()
            if (t) onRename(t)
            else setDraft(name)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            else if (e.key === 'Escape') {
              setDraft(name)
              setEditing(false)
            }
          }}
        />
      ) : (
        <button
          className="cursor-pointer border-0 bg-transparent text-[13px] font-semibold text-gray-100 hover:text-white"
          title="Rename flow"
          onClick={() => {
            setDraft(name)
            setEditing(true)
          }}
        >
          {name}
          {dirty && <span className="ml-1 text-yellow-500">•</span>}
        </button>
      )}

      <span
        className={`ml-2 rounded px-2 py-0.5 text-[11px] ${
          errors > 0
            ? 'bg-red-500/15 text-red-300'
            : warnings > 0
              ? 'bg-yellow-500/15 text-yellow-300'
              : 'bg-idle/15 text-idle'
        }`}
        data-validation-summary
      >
        {errors > 0
          ? `${errors} error${errors > 1 ? 's' : ''}`
          : warnings > 0
            ? `${warnings} warning${warnings > 1 ? 's' : ''}`
            : 'valid'}
      </span>

      <div className="ml-auto flex items-center gap-2">
        <button className={`${btn} bg-white/10 text-gray-200 hover:bg-white/20`} onClick={onNew}>
          New
        </button>
        <button
          className={`${btn} bg-white/10 text-gray-200 hover:bg-white/20`}
          onClick={onSave}
          data-flow-save
        >
          Save
        </button>
        <button
          className={`${btn} bg-running/80 hover:bg-running text-white`}
          onClick={onRun}
          disabled={errors > 0}
          data-flow-run
          title={errors > 0 ? 'Fix the errors before running' : 'Run this flow'}
        >
          Run
        </button>
      </div>
    </div>
  )
}
