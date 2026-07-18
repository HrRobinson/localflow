/**
 * Shared GitLab connector types — the NORMALIZED, stable shapes an action writes
 * to run context (§6.3) and the id vocabulary the flow-templates track + canvas
 * palette read (§6). Imported by main (the connector / normalizer) and any future
 * renderer palette surface. No I/O, no secrets: the PAT and webhook secret live
 * in the keychain (§5); these types carry only localflow-facing vocabulary.
 *
 * NO raw GitLab REST shape lives here — those are isolated in
 * `src/main/gitlab/gitlab-api.ts` (the API-version blast radius, §4.2). This file
 * holds ONLY already-normalized values: iids/ids as NUMBERS, statuses as
 * LOWERCASE enums, `labels` as a string ARRAY, timestamps ISO 8601 — the exact
 * types the (sibling-owned) edge-condition operators of §10 expect.
 *
 * Ids are kept PARALLEL to the GitHub sibling where semantics match; the one
 * systematic rename is GitHub's PR → GitLab's MR (§6).
 */

// ── Pinned dev-tool vocabulary ids (§6 — the templates track consumes these) ──

/** Webhook-backed trigger ids (§6.1), via the shared `token`-scheme receiver. */
export const GITLAB_TRIGGER_IDS = ['issue.opened', 'mr.opened', 'pipeline.failed'] as const
export type GitLabTriggerId = (typeof GITLAB_TRIGGER_IDS)[number]

/** Read action ids — pure reads that write facts for conditions (§6.2). */
export const GITLAB_READ_ACTION_IDS = ['getIssue', 'getMR', 'getPipeline', 'searchIssues'] as const

/** Gated-write action ids — the author places a gate before these; `mergeMR`
 *  MUST be gated (§9). */
export const GITLAB_WRITE_ACTION_IDS = [
  'commentIssue',
  'labelIssue',
  'createIssue',
  'openMR',
  'mergeMR'
] as const

export type GitLabActionId =
  (typeof GITLAB_READ_ACTION_IDS)[number] | (typeof GITLAB_WRITE_ACTION_IDS)[number]

// ── Normalized status enums (lowercase — exact `eq`/`ne` compares, §10) ───────

export type GitLabIssueState = 'opened' | 'closed'

export type GitLabMrState = 'opened' | 'closed' | 'merged' | 'locked'

export type GitLabPipelineStatus =
  'failed' | 'success' | 'running' | 'canceled' | 'pending' | 'skipped'

export type GitLabMergeStatus = 'can_be_merged' | 'cannot_be_merged' | 'unchecked'

// ── Context-field shapes (§6.3 — PINNED; guarded by the normalize tests) ──────

export interface GitLabIssueContext {
  issue: {
    /** Per-project issue number, e.g. 42. A NUMBER so `gt`/`lte` are meaningful. */
    iid: number
    /** Global id. */
    id: number
    projectId: number
    title: string
    state: GitLabIssueState
    /** Lowercase labels — an ARRAY so `contains 'bug'` works. */
    labels: string[]
    authorUsername: string
    webUrl: string
    /** ISO 8601. */
    createdAt: string
  }
}

export interface GitLabMrContext {
  mr: {
    iid: number
    projectId: number
    title: string
    state: GitLabMrState
    sourceBranch: string
    targetBranch: string
    /** BOOLEAN so `truthy` works (§10). */
    draft: boolean
    mergeStatus: GitLabMergeStatus
    authorUsername: string
    webUrl: string
  }
}

export interface GitLabPipelineContext {
  pipeline: {
    id: number
    projectId: number
    status: GitLabPipelineStatus
    /** Branch/tag the pipeline ran on. */
    ref: string
    sha: string
    webUrl: string
    /** Convenience for conditions — a NUMBER so `gte 1` works. */
    failedJobCount: number
  }
}

/** `searchIssues` writes a list plus a count for conditions. */
export interface GitLabIssueSearchContext {
  issues: GitLabIssueContext[]
  count: number
}

// ── Trigger payloads (§7 — the SeedEvent shape seeded into trigger context) ───

export interface GitLabIssueTriggerPayload {
  projectId: number
  issueIid: number
  action: string
}

export interface GitLabMrTriggerPayload {
  projectId: number
  mrIid: number
  action: string
}

export interface GitLabPipelineTriggerPayload {
  projectId: number
  pipelineId: number
  status: string
  ref: string
  sha: string
}

export type GitLabTriggerPayload =
  GitLabIssueTriggerPayload | GitLabMrTriggerPayload | GitLabPipelineTriggerPayload
