import { useEffect, useState } from 'react'
import type { AddPaneRequest, AgentInfo } from '../../../shared/types'
import { normalizeHttpUrl } from '../../../shared/urls'

interface Props {
  onPick: (req: AddPaneRequest) => void
  onCancel: () => void
  agents: AgentInfo[]
}

// Minimal modal: agent buttons (one per launchable preset, incl. Shell) plus
// a URL + "Browser" fallback, reusing Landing's picker CSS classes. Escape
// (no modifiers) or a backdrop click cancels — the same convention Landing's
// confirm-delete row uses for its own transient UI.
export default function AddPanePicker({ onPick, onCancel, agents }: Props): React.JSX.Element {
  const [urlInput, setUrlInput] = useState('')

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  const browserReady = normalizeHttpUrl(urlInput) !== null
  const addBrowser = (): void => {
    const normalized = normalizeHttpUrl(urlInput)
    if (normalized) onPick({ kind: 'browser', url: normalized })
  }

  return (
    <div
      className="add-pane-picker fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onMouseDown={onCancel}
    >
      <div
        className="bg-surface-raised flex w-[360px] flex-col gap-3 rounded-md border border-white/[0.14] p-4"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3 className="m-0 text-[13px] font-semibold text-gray-200">Add a companion pane</h3>
        <div className="flex flex-col gap-1.5">
          {agents.map((agent) => (
            <button
              key={agent.id}
              className="pick-agent cursor-pointer rounded-md border border-white/10 bg-white/[0.07] px-2.5 py-1.5 text-left text-[13px] text-gray-200 hover:bg-white/[0.13] disabled:cursor-default disabled:opacity-[0.45]"
              data-agent-id={agent.id}
              disabled={!agent.resolvedPath}
              onClick={() => onPick({ kind: 'terminal', agentId: agent.id })}
              onMouseDown={(e) => e.stopPropagation()}
            >
              {agent.label}
              {!agent.resolvedPath && (
                <span className="ml-1.5 text-[11px] text-gray-500">not found</span>
              )}
            </button>
          ))}
        </div>
        <div className="flex gap-1.5">
          <input
            className="url-input bg-surface focus:border-working flex-1 rounded-md border border-white/[0.14] px-2.5 py-2 font-mono text-xs text-gray-200 outline-none"
            placeholder="e.g. localhost:5173 or docs.anthropic.com"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && browserReady) addBrowser()
            }}
          />
          <button
            className="pick-browser cursor-pointer rounded-md border-0 bg-blue-600 px-2.5 py-1.5 text-[13px] text-white disabled:cursor-default disabled:opacity-[0.45]"
            disabled={!browserReady}
            onClick={addBrowser}
            onMouseDown={(e) => e.stopPropagation()}
          >
            Browser
          </button>
        </div>
        <button
          className="add-pane-cancel cursor-pointer self-end border-0 bg-transparent text-xs text-gray-400 hover:text-white"
          onClick={onCancel}
          onMouseDown={(e) => e.stopPropagation()}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
