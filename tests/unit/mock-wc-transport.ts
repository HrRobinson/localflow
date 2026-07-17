import type { WcRequest, WcResponse, WcTransport } from '../../src/main/woocommerce/wc-api'

/**
 * The offline `MockWcApi` transport seam (spec §9): `wc-api` takes its HTTP
 * transport as a constructor dep, exactly as `operator-guard.ts` injects its
 * `GuardRunner`. Tests inject this mock, which records every request and returns
 * canned WC JSON / status codes — NO test ever makes a live call.
 */
export class MockWcTransport implements WcTransport {
  readonly requests: WcRequest[] = []
  private readonly handler: (req: WcRequest, attempt: number) => WcResponse | Promise<WcResponse>

  constructor(handler: (req: WcRequest, attempt: number) => WcResponse | Promise<WcResponse>) {
    this.handler = handler
  }

  /** Number of times `send` has been called for a given method+path so far. */
  private countFor(req: WcRequest): number {
    return this.requests.filter((r) => r.method === req.method && r.url === req.url).length
  }

  async send(req: WcRequest): Promise<WcResponse> {
    const attempt = this.countFor(req)
    this.requests.push(req)
    return this.handler(req, attempt)
  }
}

/** A canned JSON 200 response. */
export const ok = (value: unknown): WcResponse => ({ status: 200, body: JSON.stringify(value) })

/** A canned error response with an optional WC-style `{ message }` body. */
export const err = (status: number, message?: string): WcResponse => ({
  status,
  body: message === undefined ? '' : JSON.stringify({ message })
})
