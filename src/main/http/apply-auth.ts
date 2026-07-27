import type { ResolvedRequest } from '../../shared/http'

/**
 * Apply a revealed secret to a resolved request per its auth scheme — the ONE
 * place auth headers are built, shared by the canvas `HttpConnector` and the
 * agent API client (design §7).
 *
 * The REVEAL deliberately stays at the caller: the connector reveals via
 * `HttpTokenStore(nodeId)`, the API client via `CollectionSecretStore(collectionId)`,
 * so each owns its own keyspace while sharing one auth code path. The secret
 * never appears in a log, an error, or an echoed request (§9).
 */
export function applyAuth(request: ResolvedRequest, secret: string): ResolvedRequest {
  const { scheme, header } = request.auth
  if (scheme === 'none') return request

  const headers = { ...request.headers }
  switch (scheme) {
    case 'bearer':
      headers['authorization'] = `Bearer ${secret}`
      break
    case 'basic':
      headers['authorization'] = `Basic ${Buffer.from(secret).toString('base64')}`
      break
    case 'header':
      headers[header ?? 'authorization'] = secret
      break
  }
  return { ...request, headers }
}
