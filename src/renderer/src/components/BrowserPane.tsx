import { useEffect, useRef, useState } from 'react'
import type { WebviewTag } from 'electron'
import type { SessionInfo } from '../../../shared/types'
import { normalizeHttpUrl } from '../../../shared/urls'

// @types/react's own <webview> intrinsic types allowpopups as boolean, but
// React 19 drops boolean values for non-boolean attributes on non-standard
// elements ("Received `true` for a non-boolean attribute" warning; the
// attribute never reaches the DOM), and that intrinsic can't be overridden
// by augmentation. This alias re-types the same host tag with the string
// form Electron needs; at runtime React still renders a plain <webview>.
type WebviewAttributes = React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
  src?: string
  partition?: string
  allowpopups?: string
}
const WebView = 'webview' as unknown as (props: WebviewAttributes) => React.JSX.Element

interface Props {
  session: SessionInfo
  enlarged: boolean
  active: boolean
  onToggleEnlarge: () => void
  onActivate: () => void
  /** Remounts an exited browser pane at its stored URL. */
  onReopen: () => void
  onClose: () => void
}

/**
 * A browser pane: same .pane shell and header discipline as TerminalPane,
 * with a guest <webview> instead of xterm. The URL bar is the one header
 * control allowed to take DOM focus; everything else preserves the
 * "clicking chrome never steals focus" rule. Navigation is followed and
 * persisted (main is the source of truth for the stored URL), so a
 * relaunch reopens where the user actually was.
 */
export default function BrowserPane({
  session,
  enlarged,
  active,
  onToggleEnlarge,
  onActivate,
  onReopen,
  onClose
}: Props): React.JSX.Element {
  const viewRef = useRef<WebviewTag | null>(null)
  // The URL bar mirrors navigation but must not clobber the user's typing:
  // editing=true freezes mirroring until Enter/Escape/blur.
  const [barValue, setBarValue] = useState(session.url ?? '')
  const [editing, setEditing] = useState(false)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const alive = session.status !== 'exited'
  // The src attribute only matters at (re)mount: after that the guest owns
  // its own navigation, and echoing session.url (updated by the 1s poll)
  // back into the attribute would force a spurious reload on every click.
  const srcRef = useRef(session.url)
  // Deliberate "uncontrolled after mount" pattern: only refreshed while
  // exited (no live webview to disturb), so the guest never sees a src
  // rewrite while it owns navigation.
  // eslint-disable-next-line react-hooks/refs -- see comment above
  if (!alive) srcRef.current = session.url

  useEffect(() => {
    if (!alive) return
    const view = viewRef.current
    if (!view) return
    const onNavigate = (): void => {
      const current = view.getURL()
      setCanGoBack(view.canGoBack())
      setCanGoForward(view.canGoForward())
      if (!editing) setBarValue(current)
      void window.localflow.setSessionUrl(session.id, current)
    }
    view.addEventListener('did-navigate', onNavigate)
    view.addEventListener('did-navigate-in-page', onNavigate)
    return () => {
      view.removeEventListener('did-navigate', onNavigate)
      view.removeEventListener('did-navigate-in-page', onNavigate)
    }
  }, [session.id, alive, editing])

  // Report this pane's guest webContents id to main so the operator control API
  // can drive the SAME webview a human drives. Registered on dom-ready (the id
  // is stable for the guest's life); unregistered on unmount / exit.
  useEffect(() => {
    if (!alive) {
      window.localflow.unregisterBrowser(session.id)
      return
    }
    const view = viewRef.current
    if (!view) return
    const onReady = (): void => {
      try {
        window.localflow.registerBrowser(session.id, view.getWebContentsId())
      } catch {
        /* guest not attached yet; a later dom-ready will catch it */
      }
    }
    view.addEventListener('dom-ready', onReady)
    return () => {
      view.removeEventListener('dom-ready', onReady)
      window.localflow.unregisterBrowser(session.id)
    }
  }, [session.id, alive])

  // Parallel to TerminalPane's xterm focus rule: the active pane's guest
  // page owns the keyboard (bound combos still work — main forwards them).
  useEffect(() => {
    if (active && alive) viewRef.current?.focus()
  }, [active, alive])

  const navigate = (): void => {
    const normalized = normalizeHttpUrl(barValue)
    if (!normalized) return // invalid input: leave the bar as-is, no nav, no refocus
    setEditing(false)
    setBarValue(normalized)
    void viewRef.current?.loadURL(normalized)
    viewRef.current?.focus()
  }

  const headerBtn =
    'cursor-pointer border-0 bg-transparent text-xs text-gray-400 hover:text-white disabled:cursor-default disabled:opacity-35 disabled:hover:text-gray-400'
  const guard = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <div
      className={
        'pane border-exited bg-surface-raised flex min-h-0 flex-col overflow-hidden rounded-lg border-2' +
        (enlarged ? ' enlarged' : '') +
        (active ? ' active' : '')
      }
      data-pane-id={session.id}
      data-status={session.status}
      onMouseDown={() => {
        onActivate()
        if (active) viewRef.current?.focus()
      }}
    >
      <div
        className="pane-header flex cursor-pointer items-center gap-2 bg-white/[0.04] px-2.5 py-1 text-xs select-none"
        onDoubleClick={onToggleEnlarge}
        onMouseDown={(e) => e.preventDefault()}
      >
        <span className="dot bg-exited h-2.5 w-2.5 rounded-full" />
        <span className="max-w-[120px] overflow-hidden text-ellipsis whitespace-nowrap">
          {session.name}
        </span>
        <input
          className="url-bar bg-surface min-w-0 flex-1 rounded border border-white/[0.14] px-1.5 py-0.5 font-mono text-[11px] text-gray-200 outline-none focus:border-white/40"
          value={barValue}
          spellCheck={false}
          onFocus={() => setEditing(true)}
          onChange={(e) => setBarValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              navigate()
            } else if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) {
              // Restore the real URL and hand focus back to the page.
              setEditing(false)
              setBarValue(viewRef.current?.getURL() ?? session.url ?? '')
              viewRef.current?.focus()
            }
          }}
          onBlur={() => setEditing(false)}
          onMouseDown={(e) => {
            // The one focusable header control: allow default (focus +
            // caret) but keep the pane root's activate-refocus from
            // yanking focus back to the webview.
            e.stopPropagation()
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        />
        <button
          className={`nav-back ${headerBtn}`}
          disabled={!alive || !canGoBack}
          onClick={() => viewRef.current?.goBack()}
          onDoubleClick={(e) => e.stopPropagation()}
          onMouseDown={guard}
        >
          ‹
        </button>
        <button
          className={`nav-forward ${headerBtn}`}
          disabled={!alive || !canGoForward}
          onClick={() => viewRef.current?.goForward()}
          onDoubleClick={(e) => e.stopPropagation()}
          onMouseDown={guard}
        >
          ›
        </button>
        <button
          className={`nav-reload ${headerBtn}`}
          disabled={!alive}
          onClick={() => viewRef.current?.reload()}
          onDoubleClick={(e) => e.stopPropagation()}
          onMouseDown={guard}
        >
          ⟳
        </button>
        <button
          className={`open-external ${headerBtn}`}
          disabled={!alive}
          title="Open in system browser"
          onClick={() => {
            const current = viewRef.current?.getURL() ?? session.url
            if (current) window.localflow.openExternal(current)
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          onMouseDown={guard}
        >
          ↗
        </button>
        <button
          className={headerBtn}
          onClick={() => {
            onActivate()
            onToggleEnlarge()
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          onMouseDown={guard}
        >
          {enlarged ? 'shrink' : 'enlarge'}
        </button>
        <button
          className={headerBtn}
          onClick={onClose}
          onDoubleClick={(e) => e.stopPropagation()}
          onMouseDown={guard}
        >
          close
        </button>
      </div>
      {alive ? (
        <WebView
          // Must equal BROWSER_PARTITION in src/main/webview-policy.ts —
          // the partition carries the deny-all permission handler.
          partition="persist:browser-panes"
          className="browser-view min-h-0 flex-1"
          // Read the same mount-time snapshot written above; this is the
          // one place a ref-during-render is the point, not an accident.
          // eslint-disable-next-line react-hooks/refs -- see comment above
          src={srcRef.current}
          // Without allowpopups, guest window.open is blocked before
          // setWindowOpenHandler ever runs. With it, popups reach the
          // handler in main (src/main/webview-policy.ts), which opens
          // http(s) targets in the system browser and always denies
          // creation of a new Electron window. STRING form on purpose:
          // React 19 drops a boolean `true` for non-boolean attributes on
          // non-standard elements (warns, attribute never reaches the
          // DOM); Electron only checks attribute presence.
          allowpopups="true"
          // The guest is a separate process/renderer: clicking inside it
          // never bubbles a mousedown to the pane root, so activation would
          // never fire from a click on the page itself. The webview element
          // does receive an embedder focus event when the guest is clicked.
          onFocus={onActivate}
          ref={(el) => {
            viewRef.current = el as WebviewTag | null
          }}
        />
      ) : (
        <div className="restart-overlay flex flex-1 flex-col items-center justify-center gap-3">
          <p className="m-0 max-w-[80%] px-4 text-center text-[13px] text-gray-400">
            {session.url}
          </p>
          <button
            className="cursor-pointer rounded-md border-0 bg-gray-700 px-4 py-2 text-white"
            onClick={onReopen}
            onMouseDown={(e) => e.preventDefault()}
          >
            Reopen
          </button>
        </div>
      )}
    </div>
  )
}
