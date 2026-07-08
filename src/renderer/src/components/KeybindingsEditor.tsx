import { useEffect, useMemo, useState } from 'react'
import {
  bindingEntries,
  serializeKeyEvent,
  findConflicts,
  DEFAULT_BINDINGS,
  type KeyAction
} from '../../../shared/keybindings'

// Human labels + grouping (spec §1: panes, environments, attention, app).
const LABELS: Record<KeyAction, string> = {
  'focus-left': 'Focus left',
  'focus-down': 'Focus down',
  'focus-up': 'Focus up',
  'focus-right': 'Focus right',
  'swap-left': 'Swap left',
  'swap-down': 'Swap down',
  'swap-up': 'Swap up',
  'swap-right': 'Swap right',
  'enlarge-toggle': 'Enlarge / shrink pane',
  'close-pane': 'Close pane',
  'new-session': 'New session',
  'go-up': 'Back / shrink',
  'toggle-sidebar': 'Toggle sidebar',
  'focus-needs-you': 'Jump to attention',
  'environment-1': 'Switch to environment 1',
  'environment-2': 'Switch to environment 2',
  'environment-3': 'Switch to environment 3',
  'environment-4': 'Switch to environment 4',
  'environment-5': 'Switch to environment 5',
  'environment-6': 'Switch to environment 6',
  'environment-7': 'Switch to environment 7',
  'environment-8': 'Switch to environment 8',
  'environment-9': 'Switch to environment 9',
  'move-to-environment-1': 'Move pane to environment 1',
  'move-to-environment-2': 'Move pane to environment 2',
  'move-to-environment-3': 'Move pane to environment 3',
  'move-to-environment-4': 'Move pane to environment 4',
  'move-to-environment-5': 'Move pane to environment 5',
  'move-to-environment-6': 'Move pane to environment 6',
  'move-to-environment-7': 'Move pane to environment 7',
  'move-to-environment-8': 'Move pane to environment 8',
  'move-to-environment-9': 'Move pane to environment 9'
}

const GROUPS: { title: string; actions: KeyAction[] }[] = [
  {
    title: 'Panes',
    actions: [
      'focus-left',
      'focus-down',
      'focus-up',
      'focus-right',
      'swap-left',
      'swap-down',
      'swap-up',
      'swap-right',
      'enlarge-toggle',
      'close-pane'
    ]
  },
  {
    title: 'Environments',
    actions: [
      'environment-1',
      'environment-2',
      'environment-3',
      'environment-4',
      'environment-5',
      'environment-6',
      'environment-7',
      'environment-8',
      'environment-9',
      'move-to-environment-1',
      'move-to-environment-2',
      'move-to-environment-3',
      'move-to-environment-4',
      'move-to-environment-5',
      'move-to-environment-6',
      'move-to-environment-7',
      'move-to-environment-8',
      'move-to-environment-9'
    ]
  },
  { title: 'Attention', actions: ['focus-needs-you'] },
  { title: 'App', actions: ['new-session', 'go-up', 'toggle-sidebar'] }
]

const rowBtn =
  'cursor-pointer rounded-md border border-white/10 bg-white/[0.07] px-2 py-1 text-xs text-gray-300 hover:bg-white/[0.13] hover:text-white'

/** A rejected capture attempt, or the "invalid" fallback — shown on the row being captured until the next action on it. */
interface PendingIssue {
  action: KeyAction
  message: string
}

export default function KeybindingsEditor(): React.JSX.Element {
  const [bindings, setBindings] = useState<Record<KeyAction, string>>({ ...DEFAULT_BINDINGS })
  const [capturing, setCapturing] = useState<KeyAction | null>(null)
  const [pendingIssue, setPendingIssue] = useState<PendingIssue | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.localflow.getKeybindings().then((b) => {
      if (!cancelled) setBindings(b)
    })
    const off = window.localflow.onKeybindingsChanged((b) => setBindings(b))
    return () => {
      cancelled = true
      off()
    }
  }, [])

  // Derived from the live bindings map, not a local shadow: normally empty
  // (main's IPC rejects any set that would collide), but a single-action
  // reset can restore a default that now collides with a manual rebind on
  // another action (resetAll can't — defaults are conflict-free). Recomputed
  // from the canonical map on every change so it self-heals as soon as
  // either colliding row is next edited.
  const rowConflicts = useMemo(() => {
    const map: Partial<Record<KeyAction, KeyAction[]>> = {}
    for (const [action, binding] of bindingEntries(bindings)) {
      const others = findConflicts(bindings, action, binding)
      if (others.length > 0) map[action] = others
    }
    return map
  }, [bindings])

  // Capture: a window-level capture-phase listener owns the keyboard while a
  // row is armed. The dataset flag makes App's dispatcher stand down so an
  // already-bound combo cannot fire mid-capture. Escape (no mods) cancels.
  useEffect(() => {
    if (!capturing) return
    const action = capturing
    document.documentElement.dataset.capturingKeybind = '1'
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        e.stopPropagation()
        setCapturing(null)
        return
      }
      const combo = serializeKeyEvent(e)
      if (combo === null) return // modifier-only / unmodified: keep waiting
      e.preventDefault()
      e.stopPropagation()
      setCapturing(null)
      // Main's IPC is the gatekeeper: it validates and rejects conflicts
      // (keybindings.json must never end up with a manual write that
      // collides), so the attempted combo is submitted directly rather than
      // pre-checked here.
      void window.localflow.setKeybinding(action, combo).then((result) => {
        if (result.ok) {
          setBindings(result.bindings)
          setPendingIssue((cur) => (cur?.action === action ? null : cur))
          return
        }
        if (result.reason === 'conflict') {
          const names = result.conflicts.map((a) => LABELS[a]).join(', ')
          setPendingIssue({ action, message: `Conflicts with ${names}` })
        } else {
          setPendingIssue({ action, message: 'Invalid key combination' })
        }
      })
    }
    window.addEventListener('keydown', handler, true)
    return () => {
      delete document.documentElement.dataset.capturingKeybind
      window.removeEventListener('keydown', handler, true)
    }
  }, [capturing])

  const resetAll = (): void => {
    setPendingIssue(null)
    void window.localflow.resetAllKeybindings().then(setBindings)
  }
  const resetOne = (action: KeyAction): void => {
    setPendingIssue((cur) => (cur?.action === action ? null : cur))
    void window.localflow.resetKeybinding(action).then(setBindings)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="m-0 text-[13px] text-gray-500">
          Click a shortcut, then press the new combination. Escape cancels. Edits apply immediately
          and round-trip with keybindings.json.
        </p>
        <button
          className={`kb-reset-all ${rowBtn}`}
          onClick={resetAll}
          onMouseDown={(e) => e.preventDefault()}
        >
          Reset all
        </button>
      </div>
      {GROUPS.map((group) => (
        <div key={group.title} className="flex flex-col gap-1.5">
          <div className="text-[11px] tracking-[0.06em] text-gray-500 uppercase">{group.title}</div>
          {group.actions.map((action) => {
            const conflictOthers = rowConflicts[action]
            const issue =
              pendingIssue?.action === action
                ? pendingIssue.message
                : conflictOthers
                  ? `Conflicts with ${conflictOthers.map((a) => LABELS[a]).join(', ')}`
                  : null
            return (
              <div
                key={action}
                className="kb-row flex items-center gap-3 rounded-md px-1 py-1"
                data-action={action}
              >
                <span className="flex-1 text-[13px] text-gray-300">{LABELS[action]}</span>
                {issue && <span className="kb-conflict text-[11px] text-yellow-400">{issue}</span>}
                <button
                  className={`kb-capture min-w-[110px] rounded-md border px-2 py-1 text-center font-mono text-[11px] ${
                    capturing === action
                      ? 'border-working/70 bg-working/10 text-working'
                      : 'border-white/10 bg-white/[0.05] text-gray-200 hover:bg-white/[0.1]'
                  }`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setPendingIssue((cur) => (cur?.action === action ? null : cur))
                    setCapturing((cur) => (cur === action ? null : action))
                  }}
                >
                  {capturing === action ? 'press keys…' : bindings[action]}
                </button>
                <button
                  className={`kb-reset ${rowBtn}`}
                  disabled={bindings[action] === DEFAULT_BINDINGS[action]}
                  onClick={() => resetOne(action)}
                  onMouseDown={(e) => e.preventDefault()}
                >
                  reset
                </button>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
