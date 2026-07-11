import { webContents as allWebContents, session as electronSession } from 'electron'
import type { WebContents, Cookie } from 'electron'
import { normalizeHttpUrl } from '../shared/urls'
import { BROWSER_PARTITION } from './webview-policy'
import type { BrowserBridge } from './browser-bridge'
import type { CaptureStore } from './capture-store'

export interface BrowserControl {
  navigate(
    handle: string,
    url: string
  ): Promise<{ ok: true; url: string } | { ok: false; error: string }>
  screenshot(
    handle: string,
    environment: number
  ): Promise<{ ok: true; path: string } | { ok: false; error: string }>
  cookies(handle: string): Promise<{ name: string; value: string; domain: string; path: string }[]>
  network(
    handle: string
  ): Promise<{ url: string; method: string; status?: number; type?: string }[]>
  act(
    handle: string,
    body: Record<string, unknown>
  ): Promise<{ ok: true } | { ok: false; error: string }>
}

interface ElectronDeps {
  fromId: (id: number) => WebContents | undefined
  partitionCookies: () => Electron.Cookies
}

/**
 * Browser control implemented over the M3.5 webview's own webContents — the
 * SAME pane a human drives. navigate → loadURL, screenshot → capturePage, and
 * ALL reads (cookies, network) are confined to the isolated
 * persist:browser-panes partition (never the user's real browser). CDP is used
 * only for network/act (Task 8). Every op degrades to an error (never crashes
 * the pane) when the webContents is gone (spec "Error handling").
 */
export class WebviewBrowserControl implements BrowserControl {
  private deps: ElectronDeps
  // Rolling CDP network buffer per handle (newest last, capped). The debugger is
  // attached lazily on first read and kept for the guest's life.
  private netBuffers = new Map<
    string,
    { url: string; method: string; status?: number; type?: string }[]
  >()
  private attached = new Set<string>()

  constructor(
    private bridge: BrowserBridge,
    private captures: CaptureStore,
    deps?: Partial<ElectronDeps>
  ) {
    this.deps = {
      fromId: deps?.fromId ?? ((id) => allWebContents.fromId(id)),
      partitionCookies:
        deps?.partitionCookies ?? (() => electronSession.fromPartition(BROWSER_PARTITION).cookies)
    }
  }

  private wc(handle: string): WebContents | null {
    const id = this.bridge.webContentsIdFor(handle)
    if (id === null) return null
    const wc = this.deps.fromId(id)
    return wc && !wc.isDestroyed() ? wc : null
  }

  private ensureNetwork(handle: string, wc: WebContents): void {
    if (this.attached.has(handle)) return
    try {
      wc.debugger.attach('1.3')
    } catch {
      // Already attached (e.g. devtools) — reuse it.
    }
    this.attached.add(handle)
    const buf: { url: string; method: string; status?: number; type?: string }[] = []
    this.netBuffers.set(handle, buf)
    wc.debugger.on('message', (_e, method, params) => {
      const p = params as Record<string, unknown>
      if (method === 'Network.requestWillBeSent') {
        const req = p['request'] as { url?: string; method?: string } | undefined
        buf.push({
          url: req?.url ?? '',
          method: req?.method ?? 'GET',
          type: p['type'] as string | undefined
        })
        if (buf.length > 200) buf.splice(0, buf.length - 200)
      } else if (method === 'Network.responseReceived') {
        const res = p['response'] as { url?: string; status?: number } | undefined
        const hit = [...buf].reverse().find((r) => r.url === res?.url && r.status === undefined)
        if (hit) hit.status = res?.status
      }
    })
    wc.debugger.sendCommand('Network.enable').catch(() => undefined)
    // Detach cleanly when the guest goes away.
    wc.once('destroyed', () => {
      this.attached.delete(handle)
      this.netBuffers.delete(handle)
    })
  }

  async navigate(
    handle: string,
    url: string
  ): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
    const normalized = normalizeHttpUrl(url)
    if (!normalized) return { ok: false, error: 'invalid url (http/https only)' }
    const wc = this.wc(handle)
    if (!wc) return { ok: false, error: 'pane unavailable' }
    try {
      await wc.loadURL(normalized)
      return { ok: true, url: normalized }
    } catch (e) {
      return { ok: false, error: `navigation failed: ${(e as Error).message}` }
    }
  }

  async screenshot(
    handle: string,
    environment: number
  ): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
    const wc = this.wc(handle)
    if (!wc) return { ok: false, error: 'pane unavailable' }
    try {
      const image = await wc.capturePage()
      const path = this.captures.writeScreenshot(environment, image.toPNG())
      return { ok: true, path }
    } catch (e) {
      return { ok: false, error: `capture failed: ${(e as Error).message}` }
    }
  }

  async cookies(
    handle: string
  ): Promise<{ name: string; value: string; domain: string; path: string }[]> {
    const wc = this.wc(handle)
    if (!wc) return []
    try {
      // Partition-confined: read the pane's own url cookies from the isolated
      // browser-panes partition, NEVER the user's real browser session.
      const list: Cookie[] = await this.deps.partitionCookies().get({ url: wc.getURL() })
      return list.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain ?? '',
        path: c.path ?? '/'
      }))
    } catch {
      return []
    }
  }

  async network(
    handle: string
  ): Promise<{ url: string; method: string; status?: number; type?: string }[]> {
    const wc = this.wc(handle)
    if (!wc) return []
    try {
      this.ensureNetwork(handle, wc)
      return [...(this.netBuffers.get(handle) ?? [])]
    } catch {
      return []
    }
  }

  async act(
    handle: string,
    body: Record<string, unknown>
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const selector = body['selector']
    const action = body['action']
    if (typeof selector !== 'string' || selector.length === 0)
      return { ok: false, error: 'selector required' }
    if (action !== 'click' && action !== 'type')
      return { ok: false, error: 'action must be click|type' }
    const wc = this.wc(handle)
    if (!wc) return { ok: false, error: 'pane unavailable' }
    // v1 selector-based act, confined to the guest page. The richer snapshot-ref
    // interaction model is deferred (spec "Out of scope"). String is JSON-encoded
    // to neutralize injection into the guest expression.
    const sel = JSON.stringify(selector)
    const text = JSON.stringify(typeof body['text'] === 'string' ? body['text'] : '')
    const expr =
      action === 'click'
        ? `(() => { const el = document.querySelector(${sel}); if (!el) return false; el.click(); return true; })()`
        : `(() => { const el = document.querySelector(${sel}); if (!el) return false; el.focus(); el.value = ${text}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`
    try {
      const ok = await wc.executeJavaScript(expr, true)
      return ok ? { ok: true } : { ok: false, error: 'selector matched nothing' }
    } catch (e) {
      return { ok: false, error: `act failed: ${(e as Error).message}` }
    }
  }
}
