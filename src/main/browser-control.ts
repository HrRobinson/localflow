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
    // Implemented in Task 8 (CDP Network buffer).
    void handle
    return []
  }

  async act(
    handle: string,
    body: Record<string, unknown>
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    // Implemented in Task 8 (selector-based executeJavaScript).
    void handle
    void body
    return { ok: false, error: 'act not enabled' }
  }
}
