import { checkBaseUrl } from '../net/ssrf-guard'
import type { GitHubAuth } from './github-auth'
import type { RawCheckRun, RawIssue, RawPull } from './github-normalize'

/**
 * Thin GitHub REST client (§4.2, §6). ALL GitHub endpoint/HTTP knowledge lives
 * here — the API-version blast radius. The `GitHubApi` interface is the seam:
 * `GitHubRestApi` wraps an INJECTED `HttpTransport` (the live HTTP call, DEFERRED
 * — see `deferredLiveTransport`), and tests inject a `MockGitHubApi`, so NO live
 * GitHub call is ever performed in CI (§12).
 *
 * Security posture:
 *  - Every request passes the (user-supplied, GHES) base URL through the shared
 *    SSRF guard BEFORE the request is built (§4.5) — a private/loopback/non-https
 *    baseUrl is refused. `api.github.com` passes trivially.
 *  - The bearer credential is resolved at call time via the injected `GitHubAuth`
 *    (keychain-backed), used ONLY to build the `Authorization` header, and is
 *    NEVER logged or returned (§8, §11).
 *  - Read methods return the RAW node; `github-normalize.ts` maps it to the
 *    pinned context shape. Write methods return a small localflow-shaped result.
 *  - Failure follows the pinned convention: every error path REJECTS with a
 *    legible, actionable message that carries the real GitHub cause — never the
 *    token (§11). The client honors `X-RateLimit-*` / `Retry-After` with capped
 *    backoff.
 */

// ── The seam ─────────────────────────────────────────────────────────────────

export interface RepoRef {
  owner: string
  repo: string
}

export interface CreateIssueInput {
  title: string
  body?: string
  labels?: string[]
}

export interface OpenPullInput {
  head: string
  base: string
  title: string
  body?: string
  draft?: boolean
}

export interface DispatchWorkflowInput {
  ref: string
  inputs?: Record<string, string>
}

export interface MergePullInput {
  method?: string
  sha?: string
}

export interface GitHubApi {
  // Reads (return raw nodes for `github-normalize`).
  issue(repo: RepoRef, number: number): Promise<RawIssue>
  pull(repo: RepoRef, number: number): Promise<RawPull>
  checkRun(repo: RepoRef, id: number): Promise<RawCheckRun>
  searchIssues(query: string): Promise<{ items: RawIssue[]; total: number }>
  // Gated writes (return small localflow-shaped results).
  createComment(repo: RepoRef, number: number, body: string): Promise<{ id: number; url: string }>
  addLabels(repo: RepoRef, number: number, labels: string[]): Promise<{ labels: string[] }>
  createIssue(repo: RepoRef, input: CreateIssueInput): Promise<{ number: number; url: string }>
  closeIssue(repo: RepoRef, number: number): Promise<{ number: number; state: string }>
  createPull(repo: RepoRef, input: OpenPullInput): Promise<{ number: number; url: string }>
  dispatchWorkflow(
    repo: RepoRef,
    workflow: string,
    input: DispatchWorkflowInput
  ): Promise<{ dispatched: true }>
  mergePull(
    repo: RepoRef,
    number: number,
    input: MergePullInput
  ): Promise<{ merged: boolean; sha: string }>
}

// ── The HTTP transport seam (the only thing that would touch the network) ────

export interface GitHubRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT'
  url: string
  headers: Record<string, string>
  body?: string
}

export interface GitHubResponse {
  status: number
  body: string
  headers?: Record<string, string>
}

export interface HttpTransport {
  send(req: GitHubRequest): Promise<GitHubResponse>
}

/** Pinned REST API version header — bumping is a ONE-FILE change (§4.1, §11). */
export const GITHUB_API_VERSION = '2022-11-28'

const DEFAULT_BASE_URL = 'https://api.github.com'
const DEFAULT_MAX_RETRIES = 3
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface GitHubRestApiDeps {
  transport: HttpTransport
  auth: GitHubAuth
  /** Default `https://api.github.com`; GHES `https://<host>/api/v3`. */
  baseUrl?: string
  sleep?: (ms: number) => Promise<void>
  maxRetries?: number
}

const enc = encodeURIComponent

export class GitHubRestApi implements GitHubApi {
  private readonly transport: HttpTransport
  private readonly auth: GitHubAuth
  private readonly baseUrl: string
  private readonly sleep: (ms: number) => Promise<void>
  private readonly maxRetries: number

  constructor(deps: GitHubRestApiDeps) {
    this.transport = deps.transport
    this.auth = deps.auth
    this.baseUrl = deps.baseUrl && deps.baseUrl.length > 0 ? deps.baseUrl : DEFAULT_BASE_URL
    this.sleep = deps.sleep ?? defaultSleep
    this.maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  async issue(repo: RepoRef, number: number): Promise<RawIssue> {
    return (await this.request(
      'GET',
      `/repos/${enc(repo.owner)}/${enc(repo.repo)}/issues/${number}`,
      {
        what: `issue #${number}`,
        repo
      }
    )) as RawIssue
  }

  async pull(repo: RepoRef, number: number): Promise<RawPull> {
    return (await this.request(
      'GET',
      `/repos/${enc(repo.owner)}/${enc(repo.repo)}/pulls/${number}`,
      {
        what: `PR #${number}`,
        repo
      }
    )) as RawPull
  }

  async checkRun(repo: RepoRef, id: number): Promise<RawCheckRun> {
    return (await this.request(
      'GET',
      `/repos/${enc(repo.owner)}/${enc(repo.repo)}/check-runs/${id}`,
      { what: `check run ${id}`, repo }
    )) as RawCheckRun
  }

  async searchIssues(query: string): Promise<{ items: RawIssue[]; total: number }> {
    const res = (await this.request('GET', `/search/issues?q=${enc(query)}`, {
      what: `search "${query}"`
    })) as { items?: RawIssue[]; total_count?: number }
    return { items: Array.isArray(res?.items) ? res.items : [], total: res?.total_count ?? 0 }
  }

  // ── Gated writes ─────────────────────────────────────────────────────────

  async createComment(
    repo: RepoRef,
    number: number,
    body: string
  ): Promise<{ id: number; url: string }> {
    const res = (await this.request(
      'POST',
      `/repos/${enc(repo.owner)}/${enc(repo.repo)}/issues/${number}/comments`,
      { what: `comment on #${number}`, repo, body: { body } }
    )) as { id?: number; html_url?: string }
    return { id: res?.id ?? 0, url: res?.html_url ?? '' }
  }

  async addLabels(repo: RepoRef, number: number, labels: string[]): Promise<{ labels: string[] }> {
    const res = (await this.request(
      'POST',
      `/repos/${enc(repo.owner)}/${enc(repo.repo)}/issues/${number}/labels`,
      { what: `label #${number}`, repo, body: { labels } }
    )) as { name?: string }[] | { name?: string }
    const arr = Array.isArray(res) ? res : []
    return { labels: arr.map((l) => l?.name ?? '').filter((n) => n.length > 0) }
  }

  async createIssue(
    repo: RepoRef,
    input: CreateIssueInput
  ): Promise<{ number: number; url: string }> {
    const body: Record<string, unknown> = { title: input.title }
    if (input.body !== undefined) body.body = input.body
    if (input.labels?.length) body.labels = input.labels
    const res = (await this.request('POST', `/repos/${enc(repo.owner)}/${enc(repo.repo)}/issues`, {
      what: 'create issue',
      repo,
      body
    })) as { number?: number; html_url?: string }
    return { number: res?.number ?? 0, url: res?.html_url ?? '' }
  }

  async closeIssue(repo: RepoRef, number: number): Promise<{ number: number; state: string }> {
    const res = (await this.request(
      'PATCH',
      `/repos/${enc(repo.owner)}/${enc(repo.repo)}/issues/${number}`,
      { what: `close #${number}`, repo, body: { state: 'closed' } }
    )) as { number?: number; state?: string }
    return { number: res?.number ?? number, state: res?.state ?? 'closed' }
  }

  async createPull(repo: RepoRef, input: OpenPullInput): Promise<{ number: number; url: string }> {
    const body: Record<string, unknown> = {
      head: input.head,
      base: input.base,
      title: input.title
    }
    if (input.body !== undefined) body.body = input.body
    if (input.draft !== undefined) body.draft = input.draft
    const res = (await this.request('POST', `/repos/${enc(repo.owner)}/${enc(repo.repo)}/pulls`, {
      what: 'open PR',
      repo,
      body
    })) as { number?: number; html_url?: string }
    return { number: res?.number ?? 0, url: res?.html_url ?? '' }
  }

  async dispatchWorkflow(
    repo: RepoRef,
    workflow: string,
    input: DispatchWorkflowInput
  ): Promise<{ dispatched: true }> {
    const body: Record<string, unknown> = { ref: input.ref }
    if (input.inputs) body.inputs = input.inputs
    await this.request(
      'POST',
      `/repos/${enc(repo.owner)}/${enc(repo.repo)}/actions/workflows/${enc(workflow)}/dispatches`,
      { what: `dispatch workflow '${workflow}'`, repo, body, expectNoContent: true }
    )
    return { dispatched: true }
  }

  async mergePull(
    repo: RepoRef,
    number: number,
    input: MergePullInput
  ): Promise<{ merged: boolean; sha: string }> {
    const body: Record<string, unknown> = {}
    if (input.method) body.merge_method = input.method
    if (input.sha) body.sha = input.sha
    const res = (await this.request(
      'PUT',
      `/repos/${enc(repo.owner)}/${enc(repo.repo)}/pulls/${number}/merge`,
      { what: `merge #${number}`, repo, body }
    )) as { merged?: boolean; sha?: string }
    return { merged: res?.merged === true, sha: res?.sha ?? '' }
  }

  // ── Transport + error mapping ────────────────────────────────────────────

  private async request(
    method: GitHubRequest['method'],
    path: string,
    opts: {
      what: string
      repo?: RepoRef
      body?: Record<string, unknown>
      expectNoContent?: boolean
    }
  ): Promise<unknown> {
    // SSRF guard BEFORE any request is built (§4.5). `api.github.com` passes
    // trivially; the guard exists for the GHES self-host baseUrl.
    const check = checkBaseUrl(this.baseUrl, 'API base URL')
    if (!check.ok) throw new Error(check.reason)

    const url = `${trimTrailingSlash(check.url.href)}${path}`
    const headers: Record<string, string> = {
      Authorization: await this.auth.authHeader(),
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      'User-Agent': 'localflow'
    }
    const req: GitHubRequest = { method, url, headers }
    if (opts.body !== undefined) {
      req.body = JSON.stringify(opts.body)
      headers['Content-Type'] = 'application/json'
    }

    let lastErr: Error | undefined
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let res: GitHubResponse
      try {
        res = await this.transport.send(req)
      } catch (err) {
        throw new Error(
          `Couldn't reach the GitHub API at ${check.url.host} — ${(err as Error).message}. Check the base URL and your connection.`,
          { cause: err }
        )
      }
      if (res.status >= 200 && res.status < 300) {
        return opts.expectNoContent ? undefined : parseJson(res.body)
      }
      // Rate-limit: retry with capped backoff honoring the reset headers.
      const retryAfter = rateLimitDelayMs(res)
      if (retryAfter !== null && attempt < this.maxRetries) {
        lastErr = new Error(`GitHub rate limit hit — resets in ~${Math.ceil(retryAfter / 1000)}s.`)
        await this.sleep(retryAfter)
        continue
      }
      // Non-retryable — map to the actionable §11 message with the real cause.
      throw mapError(res, opts.what, opts.repo)
    }
    throw (
      lastErr ?? new Error(`GitHub request '${opts.what}' failed after ${this.maxRetries} retries.`)
    )
  }
}

function trimTrailingSlash(href: string): string {
  return href.endsWith('/') ? href.slice(0, -1) : href
}

function parseJson(raw: string): unknown {
  if (!raw || raw.length === 0) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** GitHub's error `{ message }` (and `documentation_url`), if the body is JSON. */
function githubMessage(body: string): string | undefined {
  try {
    const data: unknown = JSON.parse(body)
    if (typeof data === 'object' && data !== null && 'message' in data) {
      const m = (data as { message: unknown }).message
      if (typeof m === 'string' && m.length > 0) return m
    }
  } catch {
    /* not JSON */
  }
  return undefined
}

/** ms to wait when the response is a rate-limit, else null (not rate-limited). */
function rateLimitDelayMs(res: GitHubResponse): number | null {
  const h = res.headers ?? {}
  const remaining = h['x-ratelimit-remaining'] ?? h['X-RateLimit-Remaining']
  const isRateLimited =
    (res.status === 403 || res.status === 429) &&
    (remaining === '0' || h['retry-after'] !== undefined || h['Retry-After'] !== undefined)
  if (!isRateLimited) return null
  const retryAfter = h['retry-after'] ?? h['Retry-After']
  if (retryAfter !== undefined) {
    const secs = Number(retryAfter)
    if (Number.isFinite(secs)) return Math.min(Math.max(secs * 1000, 0), 60_000)
  }
  const reset = h['x-ratelimit-reset'] ?? h['X-RateLimit-Reset']
  if (reset !== undefined) {
    const resetMs = Number(reset) * 1000 - Date.now()
    if (Number.isFinite(resetMs)) return Math.min(Math.max(resetMs, 0), 60_000)
  }
  return 1000
}

/** Map a non-retryable GitHub error to the actionable, real-cause message (§11). */
function mapError(res: GitHubResponse, what: string, repo?: RepoRef): Error {
  const detail = githubMessage(res.body)
  const where = repo ? `'${repo.owner}/${repo.repo}'` : 'the API'
  switch (res.status) {
    case 401:
      return new Error(
        'GitHub rejected the credential (401) — the token was revoked or is wrong; re-enter it in Settings.'
      )
    case 403:
      return new Error(
        `GitHub refused '${what}' (403) — the token lacks the required permission on ${where}` +
          `${detail ? `: ${detail}` : ''}. Grant it and re-enter.`
      )
    case 404:
      return new Error(
        `GitHub has no ${what} in ${where} (404) — it may be from another repo or was deleted.`
      )
    case 405:
    case 409:
    case 422:
      return new Error(
        `GitHub refused '${what}' (${res.status})${detail ? `: ${detail}` : ''} — e.g. required checks pending, a merge conflict, or an invalid request.`
      )
    default:
      return new Error(
        detail
          ? `GitHub rejected '${what}' (${res.status}): ${detail}.`
          : `GitHub rejected '${what}' (${res.status}).`
      )
  }
}

/**
 * The live HTTP transport is DEFERRED (foundation slice: no live REST). Wiring it
 * means a `fetch` to `<baseUrl>/…` with the keychain-derived bearer header (and a
 * `blockedIpRange` re-check on the resolved IP for a GHES host). Until then a
 * registered connector using this transport fails LOUDLY rather than silently.
 */
export function deferredLiveTransport(): HttpTransport {
  return {
    send: () =>
      Promise.reject(
        new Error(
          'The live GitHub REST transport is not wired yet — real calls land in a later phase. ' +
            'The connector, normalizer, auth, and webhook receiver are in place and mock-tested.'
        )
      )
  }
}

// ── The test seam ────────────────────────────────────────────────────────────

export interface MockGitHubData {
  issues?: Record<number, RawIssue>
  pulls?: Record<number, RawPull>
  checkRuns?: Record<number, RawCheckRun>
  searchResults?: RawIssue[]
  /** Seed a rejection for a given write method, exercised verbatim (the §11 path). */
  errors?: Partial<Record<keyof GitHubApi, string>>
}

/**
 * The mock seam tests inject in place of `GitHubRestApi` (§12). It returns seeded
 * raw nodes, RECORDS every write call for the authority regression (no write
 * fires without an action invocation), and rejects seeded errors verbatim —
 * exercising the connector and the engine offline, with no credentials and no
 * network. Mirrors `MockShopifyApi`.
 */
export class MockGitHubApi implements GitHubApi {
  readonly calls = {
    createComment: [] as { repo: RepoRef; number: number; body: string }[],
    addLabels: [] as { repo: RepoRef; number: number; labels: string[] }[],
    createIssue: [] as { repo: RepoRef; input: CreateIssueInput }[],
    closeIssue: [] as { repo: RepoRef; number: number }[],
    createPull: [] as { repo: RepoRef; input: OpenPullInput }[],
    dispatchWorkflow: [] as { repo: RepoRef; workflow: string; input: DispatchWorkflowInput }[],
    mergePull: [] as { repo: RepoRef; number: number; input: MergePullInput }[]
  }

  constructor(private readonly data: MockGitHubData = {}) {}

  private fail(method: keyof GitHubApi): Promise<never> | null {
    const msg = this.data.errors?.[method]
    return msg ? Promise.reject(new Error(msg)) : null
  }

  issue(_repo: RepoRef, number: number): Promise<RawIssue> {
    const node = this.data.issues?.[number]
    if (!node) return Promise.reject(new Error(`GitHub has no issue #${number} (404).`))
    return Promise.resolve(node)
  }

  pull(_repo: RepoRef, number: number): Promise<RawPull> {
    const node = this.data.pulls?.[number]
    if (!node) return Promise.reject(new Error(`GitHub has no PR #${number} (404).`))
    return Promise.resolve(node)
  }

  checkRun(_repo: RepoRef, id: number): Promise<RawCheckRun> {
    const node = this.data.checkRuns?.[id]
    if (!node) return Promise.reject(new Error(`GitHub has no check run ${id} (404).`))
    return Promise.resolve(node)
  }

  searchIssues(_query: string): Promise<{ items: RawIssue[]; total: number }> {
    void _query
    const items = this.data.searchResults ?? []
    return Promise.resolve({ items, total: items.length })
  }

  createComment(repo: RepoRef, number: number, body: string): Promise<{ id: number; url: string }> {
    this.calls.createComment.push({ repo, number, body })
    return this.fail('createComment') ?? Promise.resolve({ id: 1, url: '' })
  }

  addLabels(repo: RepoRef, number: number, labels: string[]): Promise<{ labels: string[] }> {
    this.calls.addLabels.push({ repo, number, labels })
    return this.fail('addLabels') ?? Promise.resolve({ labels })
  }

  createIssue(repo: RepoRef, input: CreateIssueInput): Promise<{ number: number; url: string }> {
    this.calls.createIssue.push({ repo, input })
    return this.fail('createIssue') ?? Promise.resolve({ number: 100, url: '' })
  }

  closeIssue(repo: RepoRef, number: number): Promise<{ number: number; state: string }> {
    this.calls.closeIssue.push({ repo, number })
    return this.fail('closeIssue') ?? Promise.resolve({ number, state: 'closed' })
  }

  createPull(repo: RepoRef, input: OpenPullInput): Promise<{ number: number; url: string }> {
    this.calls.createPull.push({ repo, input })
    return this.fail('createPull') ?? Promise.resolve({ number: 200, url: '' })
  }

  dispatchWorkflow(
    repo: RepoRef,
    workflow: string,
    input: DispatchWorkflowInput
  ): Promise<{ dispatched: true }> {
    this.calls.dispatchWorkflow.push({ repo, workflow, input })
    return this.fail('dispatchWorkflow') ?? Promise.resolve({ dispatched: true })
  }

  mergePull(
    repo: RepoRef,
    number: number,
    input: MergePullInput
  ): Promise<{ merged: boolean; sha: string }> {
    this.calls.mergePull.push({ repo, number, input })
    return this.fail('mergePull') ?? Promise.resolve({ merged: true, sha: 'merged-sha' })
  }
}
