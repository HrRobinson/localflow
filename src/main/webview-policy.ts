import { app, session, shell } from 'electron'
import { isHttpUrl } from '../shared/urls'
import {
  parseBinding,
  eventMatches,
  bindingEntries,
  type KeyAction,
  type KeyEventLike
} from '../shared/keybindings'

/** The isolated storage partition every browser-pane webview runs in. */
export const BROWSER_PARTITION = 'persist:browser-panes'

/**
 * Webview pages are the app's only untrusted content — policy is stricter
 * than the app window (spec §3): all permission prompts denied, navigation
 * confined to http(s), popups sent to the system browser, and bound key
 * combos forwarded back to the app's dispatcher (keystrokes inside a
 * focused webview never bubble to the embedder DOM, so cmd+1…9 etc. would
 * otherwise die whenever a browser pane has focus).
 */
export function installWebviewPolicy(opts: {
  bindings: Record<KeyAction, string>
  onAction: (action: KeyAction) => void
}): void {
  session.fromPartition(BROWSER_PARTITION).setPermissionRequestHandler((_wc, _permission, cb) => {
    cb(false)
  })

  const parsed = bindingEntries(opts.bindings).flatMap(([action, binding]) => {
    const p = parseBinding(binding)
    return p ? ([[action, p]] as const) : []
  })

  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return

    contents.setWindowOpenHandler(({ url }) => {
      if (isHttpUrl(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, url) => {
      if (!isHttpUrl(url)) event.preventDefault()
    })
    // Defense-in-depth: Chromium already blocks unsafe navigation targets
    // (file:, javascript:, etc.) natively for these two events, but the
    // guard is cheap and keeps every navigation-shaped event on one policy.
    contents.on('will-frame-navigate', (event) => {
      if (!isHttpUrl(event.url)) event.preventDefault()
    })
    contents.on('will-redirect', (event) => {
      if (!isHttpUrl(event.url)) event.preventDefault()
    })
    contents.on('before-input-event', (event, input) => {
      // rawKeyDown is reported instead of keyDown for some key paths;
      // accepted defensively so a bound combo is never silently dropped.
      // Matched-combos-only forwarding keeps plain typing untouched.
      if (input.type !== 'keyDown' && input.type !== 'rawKeyDown') return
      const like: KeyEventLike = {
        key: input.key,
        metaKey: input.meta,
        ctrlKey: input.control,
        altKey: input.alt,
        shiftKey: input.shift,
        code: input.code
      }
      const match = parsed.find(([, binding]) => eventMatches(binding, like))
      if (!match) return
      event.preventDefault()
      opts.onAction(match[0])
    })
  })
}
