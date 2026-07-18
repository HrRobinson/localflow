import type { IncomingHttpHeaders } from 'node:http'
import type { HttpResponseContext, WebhookContext } from '../../shared/http'
import type { HttpRawResponse } from './http-client'

/**
 * PURE mapping (spec §6.5, §10) — the correctness boundary the conditions track
 * reads by dotted path (`fetch.http.status`, `webhook.body.type`). A raw
 * response → the pinned `HttpResponseContext`; a verified inbound request → the
 * pinned `WebhookContext`. JSON is parsed only when the content-type says so
 * (else the body stays a string); header keys are lowercased; `ok` is derived
 * from the status. Never throws — a body that claims JSON but doesn't parse
 * falls back to the raw string, so a malformed remote never crashes a run.
 */

function isJsonContentType(headers: Record<string, string>): boolean {
  const ct = headers['content-type'] ?? ''
  return /\bapplication\/(?:[\w.+-]+\+)?json\b|\btext\/json\b/i.test(ct)
}

/** Parse a body string as JSON when the content-type is JSON, else return the
 *  string. A JSON content-type whose body doesn't parse falls back to the raw
 *  string (never throws). */
function parseBody(body: string, headers: Record<string, string>): unknown {
  if (!isJsonContentType(headers)) return body
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

/** Lowercase every header key; a duplicated (array) value joins with ", ". */
function lowerHeaders(
  headers: Record<string, string | string[] | undefined>
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value
  }
  return out
}

/** A raw response → the pinned `HttpResponseContext` (§6.5). */
export function responseToContext(res: HttpRawResponse): HttpResponseContext {
  const headers = lowerHeaders(res.headers)
  return {
    http: {
      status: res.status,
      ok: res.status >= 200 && res.status <= 299,
      headers,
      body: parseBody(res.body, headers)
    }
  }
}

/** A verified inbound request → the pinned `WebhookContext` (§6.5, Half 2). The
 *  body is parsed by the request's content-type; the query string is parsed into
 *  a flat map (last value wins for a repeated key). */
export function webhookToContext(
  rawBody: Buffer | string,
  headers: IncomingHttpHeaders,
  rawUrl: string
): WebhookContext {
  const lowered = lowerHeaders(headers)
  const bodyStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8')
  const query: Record<string, string> = {}
  const qIndex = rawUrl.indexOf('?')
  if (qIndex !== -1) {
    for (const [key, value] of new URLSearchParams(rawUrl.slice(qIndex + 1))) {
      query[key] = value
    }
  }
  return {
    webhook: {
      headers: lowered,
      body: parseBody(bodyStr, lowered),
      query
    }
  }
}
