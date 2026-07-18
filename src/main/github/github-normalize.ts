import type {
  GitHubCheckConclusion,
  GitHubCheckRunContext,
  GitHubCheckStatus,
  GitHubChecksState,
  GitHubIssueContext,
  GitHubIssueState,
  GitHubPRContext,
  GitHubPRState,
  GitHubTriggerId
} from '../../shared/github'
import { GITHUB_FAILURE_CONCLUSIONS } from '../../shared/github'

/**
 * PURE normalization (§6.3, §10) — the correctness boundary the conditions track
 * depends on. A raw GitHub REST node (or a raw webhook body) becomes the PINNED
 * context/trigger shape: numeric ids, lowercase state/conclusion enums, `labels`
 * as a lowercased `string[]`, `state:'merged'` distinguished from a plain
 * `'closed'`, and `mergeable:null → undefined`. Never throws — a sparse/garbage
 * node normalizes to safe defaults so a malformed read never crashes a run
 * (mirrors `shopify-normalize.ts`).
 */

// ── Raw REST node shapes (isolated to the api/normalize boundary) ────────────

export interface RawUser {
  login?: string | null
}

export interface RawLabel {
  name?: string | null
}

export interface RawIssue {
  number?: number | null
  title?: string | null
  body?: string | null
  state?: string | null
  user?: RawUser | null
  labels?: (RawLabel | string)[] | null
  html_url?: string | null
  created_at?: string | null
  /** ".../repos/OWNER/REPO" — used to derive `repo` when none is passed. */
  repository_url?: string | null
}

export interface RawPull {
  number?: number | null
  title?: string | null
  state?: string | null
  merged?: boolean | null
  draft?: boolean | null
  user?: RawUser | null
  head?: { ref?: string | null; sha?: string | null } | null
  base?: { ref?: string | null; repo?: { full_name?: string | null } | null } | null
  mergeable?: boolean | null
  /** Aggregate checks roll-up when available (GraphQL/status API). */
  checksState?: string | null
  html_url?: string | null
  created_at?: string | null
}

export interface RawCheckRun {
  id?: number | null
  name?: string | null
  status?: string | null
  conclusion?: string | null
  head_sha?: string | null
  details_url?: string | null
  output?: { summary?: string | null } | null
  pull_requests?: { number?: number | null }[] | null
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** Parse `owner/name` out of a `repository_url` (".../repos/owner/name"). */
function repoFromUrl(url: string | null | undefined): string {
  const m = /\/repos\/([^/]+\/[^/]+)$/.exec(str(url))
  return m ? m[1] : ''
}

function issueState(raw: string | null | undefined): GitHubIssueState {
  return str(raw).toLowerCase() === 'closed' ? 'closed' : 'open'
}

function labelNames(labels: RawIssue['labels']): string[] {
  if (!Array.isArray(labels)) return []
  return labels
    .map((l) => (typeof l === 'string' ? l : str(l?.name)))
    .filter((s) => s.length > 0)
    .map((s) => s.toLowerCase())
}

// ── Read normalizers ─────────────────────────────────────────────────────────

export function normalizeIssue(raw: RawIssue, repo = ''): GitHubIssueContext {
  return {
    issue: {
      number: num(raw?.number),
      title: str(raw?.title),
      body: str(raw?.body),
      state: issueState(raw?.state),
      author: str(raw?.user?.login),
      labels: labelNames(raw?.labels),
      repo: repo || repoFromUrl(raw?.repository_url),
      url: str(raw?.html_url),
      createdAt: str(raw?.created_at)
    }
  }
}

function prState(raw: RawPull): GitHubPRState {
  // A merged PR is 'closed' in GitHub's own `state`; localflow distinguishes it.
  if (raw?.merged === true) return 'merged'
  return str(raw?.state).toLowerCase() === 'closed' ? 'closed' : 'open'
}

function checksState(raw: string | null | undefined): GitHubChecksState {
  const v = str(raw).toLowerCase()
  if (v === 'success' || v === 'failure' || v === 'pending') return v
  return 'unknown'
}

export function normalizePull(raw: RawPull, repo = ''): GitHubPRContext {
  return {
    pr: {
      number: num(raw?.number),
      title: str(raw?.title),
      state: prState(raw),
      draft: raw?.draft === true,
      author: str(raw?.user?.login),
      headRef: str(raw?.head?.ref),
      baseRef: str(raw?.base?.ref),
      headSha: str(raw?.head?.sha),
      // GitHub returns null while it computes mergeability → undefined.
      mergeable: typeof raw?.mergeable === 'boolean' ? raw.mergeable : undefined,
      checksState: checksState(raw?.checksState),
      repo: repo || str(raw?.base?.repo?.full_name),
      url: str(raw?.html_url),
      createdAt: str(raw?.created_at)
    }
  }
}

const CHECK_STATUSES: ReadonlySet<string> = new Set<GitHubCheckStatus>([
  'queued',
  'in_progress',
  'completed'
])

const CHECK_CONCLUSIONS: ReadonlySet<string> = new Set([
  'success',
  'failure',
  'timed_out',
  'cancelled',
  'action_required',
  'neutral',
  'skipped',
  'stale'
])

function checkStatus(raw: string | null | undefined): GitHubCheckStatus {
  const v = str(raw).toLowerCase()
  return CHECK_STATUSES.has(v) ? (v as GitHubCheckStatus) : 'completed'
}

function checkConclusion(raw: string | null | undefined): GitHubCheckConclusion {
  const v = str(raw).toLowerCase()
  return CHECK_CONCLUSIONS.has(v) ? (v as GitHubCheckConclusion) : null
}

export function normalizeCheckRun(raw: RawCheckRun, repo = ''): GitHubCheckRunContext {
  const prs = Array.isArray(raw?.pull_requests) ? raw.pull_requests : []
  const first = prs.find((p) => typeof p?.number === 'number')
  return {
    checkRun: {
      id: num(raw?.id),
      name: str(raw?.name),
      status: checkStatus(raw?.status),
      conclusion: checkConclusion(raw?.conclusion),
      prNumber: first ? num(first.number) : undefined,
      headSha: str(raw?.head_sha),
      repo,
      detailsUrl: str(raw?.details_url),
      outputSummary: str(raw?.output?.summary)
    }
  }
}

// ── Webhook body → trigger (§6.1) ────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function repoFullName(raw: Record<string, unknown>): string {
  const repository = raw.repository
  if (isObj(repository) && typeof repository.full_name === 'string') return repository.full_name
  return ''
}

const isFailure = (conclusion: unknown): boolean =>
  (GITHUB_FAILURE_CONCLUSIONS as readonly string[]).includes(str(conclusion).toLowerCase())

/**
 * Map a raw (untrusted) webhook body — dispatched by its `X-GitHub-Event` type —
 * to the pinned trigger id + its normalized context payload, or `null` when the
 * event/action isn't one localflow triggers on (so no run is ever seeded on an
 * uninteresting delivery). `check.failed`/`workflow.failed` are DERIVED filters
 * over the native `completed` events: only a failing conclusion fires (§6.1).
 */
export function webhookToTrigger(
  event: string,
  raw: unknown
): { triggerId: GitHubTriggerId; payload: unknown } | null {
  if (!isObj(raw)) return null
  const action = str(raw.action)
  const repo = repoFullName(raw)

  if (event === 'issues' && action === 'opened' && isObj(raw.issue)) {
    return { triggerId: 'issue.opened', payload: normalizeIssue(raw.issue as RawIssue, repo) }
  }

  if (event === 'pull_request' && action === 'opened' && isObj(raw.pull_request)) {
    return { triggerId: 'pr.opened', payload: normalizePull(raw.pull_request as RawPull, repo) }
  }

  if (event === 'check_run' && action === 'completed' && isObj(raw.check_run)) {
    const cr = raw.check_run as RawCheckRun
    if (!isFailure(cr.conclusion)) return null
    return { triggerId: 'check.failed', payload: normalizeCheckRun(cr, repo) }
  }

  if (event === 'workflow_run' && action === 'completed' && isObj(raw.workflow_run)) {
    const wr = raw.workflow_run as Record<string, unknown>
    if (!isFailure(wr.conclusion)) return null
    return {
      triggerId: 'workflow.failed',
      payload: {
        workflowRun: {
          id: num(wr.id),
          name: str(wr.name),
          conclusion: str(wr.conclusion).toLowerCase(),
          headSha: str(wr.head_sha),
          repo,
          url: str(wr.html_url)
        }
      }
    }
  }

  return null
}
