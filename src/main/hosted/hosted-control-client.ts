import { randomUUID } from 'node:crypto'
import type { IntegrationId } from '../../shared/integrations'

/**
 * The thin client to the relay's CONTROL API (provision/list ingress URLs, mint a
 * scoped drain token). ALL relay wire-shapes are isolated in this file so the rest
 * of the app never imports a relay type. Auth is the ACCOUNT TOKEN (keychain,
 * main-only, never logged). The live HTTP client is DEFERRED — the relay is a
 * separate private repo whose API isn't frozen — so `MockControlApi` drives every
 * test and `HttpControlApi` is a loud stub until the API lands (design O-3).
 */

/** A provisioned ingress URL the user pastes into a vendor's webhook settings. */
export interface IngressUrl {
  /** == Delivery.ingressUrlId. */
  id: string
  integration: IntegrationId
  /** The public URL the vendor delivers to (also the `publicUrl` for URL-signed
   *  schemes). Unguessable per-tenant path; treated as capability-bearing but a
   *  non-secret ref in config is fine. */
  url: string
  createdAt: string
}

/** The scoped, short-lived credential the IngressSource uses to PULL Pub/Sub.
 *  Scoped to this tenant's subscription only; NEVER logged; refreshed via the
 *  control API. Held in memory only for the drain loop's lifetime. */
export interface DrainToken {
  token: string
  subscription: string
  expiresAt: string
}

export interface HostedControlApi {
  /** List the tenant's provisioned ingress URLs. */
  listIngressUrls(): Promise<IngressUrl[]>
  /** Provision a new ingress URL for an integration; returns the pasteable URL. */
  provisionIngressUrl(integration: IntegrationId): Promise<IngressUrl>
  /** Mint/refresh the scoped Pub/Sub pull token. */
  mintDrainToken(): Promise<DrainToken>
}

/**
 * Offline control API for tests: canned URLs + a fake token. No network. Seeded
 * URLs list back verbatim; `provisionIngressUrl` appends an unguessable URL. The
 * minted token value is synthetic and never logged.
 */
export class MockControlApi implements HostedControlApi {
  private readonly urls: IngressUrl[]
  private readonly log: (message: string) => void

  constructor(deps: { ingressUrls?: IngressUrl[]; log?: (message: string) => void } = {}) {
    this.urls = [...(deps.ingressUrls ?? [])]
    this.log = deps.log ?? ((): void => {})
  }

  listIngressUrls(): Promise<IngressUrl[]> {
    return Promise.resolve([...this.urls])
  }

  provisionIngressUrl(integration: IntegrationId): Promise<IngressUrl> {
    const id = `url_${randomUUID()}`
    const url: IngressUrl = {
      id,
      integration,
      url: `https://relay.example.com/t/${randomUUID()}/${integration}`,
      createdAt: new Date(0).toISOString()
    }
    this.urls.push(url)
    // Route + reason only — never the token or a secret.
    this.log(`hosted control (mock): provisioned ingress URL for '${integration}'`)
    return Promise.resolve(url)
  }

  mintDrainToken(): Promise<DrainToken> {
    // A synthetic scoped token; the value is NEVER logged.
    this.log('hosted control (mock): minted a scoped drain token')
    return Promise.resolve({
      token: `drain_${randomUUID()}`,
      subscription: 'projects/mock/subscriptions/tenant',
      expiresAt: new Date(3600_000).toISOString()
    })
  }
}

/**
 * DEFERRED live client. Constructed with the account-token reveal + base URL;
 * every method throws a legible "not wired yet" until the relay's API is frozen
 * (design O-3). The account token is read main-only and NEVER logged or placed in
 * the error message.
 */
export class HttpControlApi implements HostedControlApi {
  constructor(
    private readonly deps: {
      baseUrl: string
      /** Account-token reveal (keychain, main-only). NEVER logged. */
      accountToken: () => string
      log?: (message: string) => void
    }
  ) {}

  private notWired(): never {
    void this.deps
    throw new Error(
      'Hosted control API is not wired yet — the client contract (provision/list ingress ' +
        'URLs, mint drain token) and MockControlApi are in place, but the live HTTP client ' +
        'lands once the relay API is frozen (design O-3). Configure a mock until then.'
    )
  }

  listIngressUrls(): Promise<IngressUrl[]> {
    return Promise.reject(this.wiredError())
  }

  provisionIngressUrl(_integration: IntegrationId): Promise<IngressUrl> {
    void _integration
    return Promise.reject(this.wiredError())
  }

  mintDrainToken(): Promise<DrainToken> {
    return Promise.reject(this.wiredError())
  }

  private wiredError(): Error {
    try {
      this.notWired()
    } catch (err) {
      return err as Error
    }
    // Unreachable — notWired always throws.
    return new Error('Hosted control API is not wired yet.')
  }
}
