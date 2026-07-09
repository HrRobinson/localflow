/** Browser control over the M3.5 webview. Implemented in Layer 2. */
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
