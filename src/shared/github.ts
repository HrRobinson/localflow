/**
 * Shared GitHub connector types — the pinned id constants (the templates track
 * consumes these verbatim) and the NORMALIZED, stable context shapes an action
 * or trigger writes to run context (§6.3). Imported by main (the connector /
 * normalizer / api) and any renderer palette surface.
 *
 * NO raw GitHub REST/GraphQL shape lives here — those are isolated in
 * `src/main/github/github-api.ts` (the API-version blast radius, §4.1). This
 * file holds ONLY saiife-facing, already-normalized vocabulary: numeric ids,
 * lowercase state/conclusion enums, `labels` as a `string[]`, and `state:
 * 'merged'` distinguished from a plain `'closed'` — the exact types the
 * (sibling-owned) edge-condition operators of §10 expect.
 */

// ── Pinned dev vocabulary ids (§6 — the templates track consumes these) ──────

/** Webhook-backed trigger ids (§6.1). */
export const GITHUB_TRIGGER_IDS = [
  'issue.opened',
  'pr.opened',
  'check.failed',
  'workflow.failed'
] as const
export type GitHubTriggerId = (typeof GITHUB_TRIGGER_IDS)[number]

/** Read action ids — pure reads that write facts for conditions (§6.2). */
export const GITHUB_READ_ACTION_IDS = ['getIssue', 'getPR', 'getCheckRun', 'searchIssues'] as const

/** Gated-write action ids — the author places a gate before these (§6.2). The
 *  final entry, `mergePR`, is the sharpest gated-mutation contract (§9). */
export const GITHUB_WRITE_ACTION_IDS = [
  'commentIssue',
  'labelIssue',
  'createIssue',
  'closeIssue',
  'openPR',
  'dispatchWorkflow',
  'mergePR'
] as const

export type GitHubActionId =
  (typeof GITHUB_READ_ACTION_IDS)[number] | (typeof GITHUB_WRITE_ACTION_IDS)[number]

// ── Normalized enums (lowercase — exact `eq`/`ne` compares, §10) ─────────────

export type GitHubIssueState = 'open' | 'closed'

/** `'merged'` is distinguished from a plain `'closed'` PR (§6.3). */
export type GitHubPRState = 'open' | 'closed' | 'merged'

export type GitHubCheckStatus = 'queued' | 'in_progress' | 'completed'

export type GitHubCheckConclusion =
  | 'success'
  | 'failure'
  | 'timed_out'
  | 'cancelled'
  | 'action_required'
  | 'neutral'
  | 'skipped'
  | 'stale'
  | null

/** A PR's aggregate checks roll-up (§6.3). */
export type GitHubChecksState = 'success' | 'failure' | 'pending' | 'unknown'

/** The webhook `check_run`/`workflow_run` conclusions the connector treats as a
 *  FAILURE — the derived filter behind `check.failed`/`workflow.failed` (§6.1). */
export const GITHUB_FAILURE_CONCLUSIONS = ['failure', 'timed_out', 'cancelled'] as const

// ── Context-field shapes (§6.3 — PINNED; guarded by the normalize tests) ─────

export interface GitHubIssueContext {
  issue: {
    number: number
    title: string
    body: string
    state: GitHubIssueState
    /** Login of the author. */
    author: string
    /** Label names, lowercased for stable eq/contains (§10). */
    labels: string[]
    /** "owner/name". */
    repo: string
    /** html_url. */
    url: string
    /** ISO 8601. */
    createdAt: string
  }
}

export interface GitHubPRContext {
  pr: {
    number: number
    title: string
    state: GitHubPRState
    draft: boolean
    /** Login of the author. */
    author: string
    /** Source branch. */
    headRef: string
    /** Target branch, e.g. "main". */
    baseRef: string
    headSha: string
    /** GitHub returns null while computing mergeability → undefined. */
    mergeable: boolean | undefined
    checksState: GitHubChecksState
    /** "owner/name". */
    repo: string
    url: string
    createdAt: string
  }
}

export interface GitHubCheckRunContext {
  checkRun: {
    id: number
    name: string
    status: GitHubCheckStatus
    conclusion: GitHubCheckConclusion
    /** The associated PR, when the check is on a PR head; else undefined. */
    prNumber: number | undefined
    headSha: string
    /** "owner/name". */
    repo: string
    /** Where the failing logs live — handed to the coding agent (§7). */
    detailsUrl: string
    /** The check's short output text, if any. */
    outputSummary: string
  }
}

/** `searchIssues` result — the normalized issues plus a count (§6.2). */
export interface GitHubIssueSearchContext {
  items: GitHubIssueContext[]
  count: number
}

// ── Action param shapes (what a flow node passes to `invokeAction`) ──────────

/** Every action optionally overrides the config-default repo per node. */
export interface RepoOverride {
  owner?: string
  repo?: string
}

export interface GetIssueParams extends RepoOverride {
  number: number | string
}

export interface GetPRParams extends RepoOverride {
  number: number | string
}

export interface GetCheckRunParams extends RepoOverride {
  id: number | string
}

export interface SearchIssuesParams {
  /** A raw GitHub `search/issues` query, e.g. "repo:acme/web is:open label:bug". */
  query: string
}

export interface CommentIssueParams extends RepoOverride {
  number: number | string
  body: string
}

export interface LabelIssueParams extends RepoOverride {
  number: number | string
  /** One label, or a comma-list / array of them. */
  labels: string | string[]
}

export interface CreateIssueParams extends RepoOverride {
  title: string
  body?: string
  labels?: string | string[]
}

export interface CloseIssueParams extends RepoOverride {
  number: number | string
}

export interface OpenPRParams extends RepoOverride {
  head: string
  base: string
  title: string
  body?: string
  draft?: boolean
}

export interface DispatchWorkflowParams extends RepoOverride {
  /** The workflow file name (`ci.yml`) or numeric id. */
  workflow: string | number
  /** Git ref to run on, e.g. "main". */
  ref: string
  inputs?: Record<string, string>
}

export interface MergePRParams extends RepoOverride {
  number: number | string
  /** 'merge' | 'squash' | 'rebase'. Defaults to 'merge'. */
  method?: string
  /** Optional head SHA the PR must still be at (safe-merge guard). */
  sha?: string
}
