import type {
  GitLabIssueContext,
  GitLabIssueState,
  GitLabMergeStatus,
  GitLabMrContext,
  GitLabMrState,
  GitLabPipelineContext,
  GitLabPipelineStatus,
  GitLabTriggerId,
  GitLabTriggerPayload
} from '../../shared/gitlab'

/**
 * PURE normalization (spec §6.3, §12) — the correctness boundary the conditions
 * track depends on. A raw GitLab REST node (or a raw webhook Hook body) becomes
 * the PINNED context/trigger shape: iids/ids as NUMBERS, statuses as LOWERCASE
 * enums, `labels` as a string ARRAY, timestamps ISO 8601. Never throws — a
 * sparse/garbage node normalizes to safe defaults so a malformed read never
 * crashes a run (mirrors `wc-normalize.ts` / `shopify-normalize.ts` purity).
 */

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function str(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return ''
}

/** Coerce to a finite integer; garbage/absent → 0. */
function num(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return 0
}

/** Lowercase labels into a string array. GitLab returns labels as either strings
 *  (`["bug"]`) or label objects (`[{ name: "bug" }]`) depending on endpoint. */
function labelArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const item of v) {
    if (typeof item === 'string' && item.length > 0) out.push(item.toLowerCase())
    else if (isObject(item) && typeof item.name === 'string' && item.name.length > 0) {
      out.push(item.name.toLowerCase())
    }
  }
  return out
}

const ISSUE_STATES: ReadonlySet<string> = new Set<GitLabIssueState>(['opened', 'closed'])
function issueState(v: unknown): GitLabIssueState {
  const s = str(v).toLowerCase()
  return ISSUE_STATES.has(s) ? (s as GitLabIssueState) : 'opened'
}

const MR_STATES: ReadonlySet<string> = new Set<GitLabMrState>([
  'opened',
  'closed',
  'merged',
  'locked'
])
function mrState(v: unknown): GitLabMrState {
  const s = str(v).toLowerCase()
  return MR_STATES.has(s) ? (s as GitLabMrState) : 'opened'
}

const PIPELINE_STATUSES: ReadonlySet<string> = new Set<GitLabPipelineStatus>([
  'failed',
  'success',
  'running',
  'canceled',
  'pending',
  'skipped'
])
function pipelineStatus(v: unknown): GitLabPipelineStatus {
  const s = str(v).toLowerCase()
  // GitLab spells it "canceled" in the API; accept the "cancelled" variant too.
  if (s === 'cancelled') return 'canceled'
  return PIPELINE_STATUSES.has(s) ? (s as GitLabPipelineStatus) : 'pending'
}

const MERGE_STATUSES: ReadonlySet<string> = new Set<GitLabMergeStatus>([
  'can_be_merged',
  'cannot_be_merged',
  'unchecked'
])
function mergeStatus(v: unknown): GitLabMergeStatus {
  const s = str(v).toLowerCase()
  return MERGE_STATUSES.has(s) ? (s as GitLabMergeStatus) : 'unchecked'
}

/** GitLab returns `author: { username }`. */
function authorUsername(raw: Record<string, unknown>): string {
  const author = raw.author
  if (isObject(author)) return str(author.username)
  return ''
}

// ── REST node → context shape (§6.3) ─────────────────────────────────────────

export function normalizeIssue(raw: unknown): GitLabIssueContext {
  const o = isObject(raw) ? raw : {}
  return {
    issue: {
      iid: num(o.iid),
      id: num(o.id),
      projectId: num(o.project_id),
      title: str(o.title),
      state: issueState(o.state),
      labels: labelArray(o.labels),
      authorUsername: authorUsername(o),
      webUrl: str(o.web_url),
      createdAt: str(o.created_at)
    }
  }
}

export function normalizeMR(raw: unknown): GitLabMrContext {
  const o = isObject(raw) ? raw : {}
  // GitLab exposes both `draft` and (legacy) `work_in_progress`.
  const draft = o.draft === true || o.work_in_progress === true
  return {
    mr: {
      iid: num(o.iid),
      projectId: num(o.project_id),
      title: str(o.title),
      state: mrState(o.state),
      sourceBranch: str(o.source_branch),
      targetBranch: str(o.target_branch),
      draft,
      mergeStatus: mergeStatus(o.merge_status),
      authorUsername: authorUsername(o),
      webUrl: str(o.web_url)
    }
  }
}

/** Count failed jobs from an embedded builds/jobs array, when the caller passes
 *  one alongside the pipeline (the webhook Pipeline Hook carries `builds`). */
function failedJobCount(raw: Record<string, unknown>): number {
  const builds = raw.builds ?? raw.jobs
  if (!Array.isArray(builds)) return 0
  return builds.filter((b) => isObject(b) && str(b.status).toLowerCase() === 'failed').length
}

export function normalizePipeline(raw: unknown): GitLabPipelineContext {
  const o = isObject(raw) ? raw : {}
  return {
    pipeline: {
      id: num(o.id),
      projectId: num(o.project_id),
      status: pipelineStatus(o.status),
      ref: str(o.ref),
      sha: str(o.sha),
      webUrl: str(o.web_url),
      failedJobCount: failedJobCount(o)
    }
  }
}

// ── Webhook Hook body → trigger (§6.1, §7) ───────────────────────────────────

/** The GitLab `X-Gitlab-Event` header values this connector handles. */
const EVENT_ISSUE = 'Issue Hook'
const EVENT_MR = 'Merge Request Hook'
const EVENT_PIPELINE = 'Pipeline Hook'

export interface GitLabSeed {
  triggerId: GitLabTriggerId
  payload: GitLabTriggerPayload
}

/**
 * Map a verified GitLab webhook (its `X-Gitlab-Event` value + raw JSON body) to
 * the trigger id + SeedEvent payload, or `null` when the event is unsupported or
 * does NOT match the trigger's filter — so a non-`open` issue/MR or a
 * non-`failed` pipeline NEVER seeds a run (spec §4.4, §6.1). Pure + defensive.
 */
export function webhookToSeed(event: string, raw: unknown): GitLabSeed | null {
  if (!isObject(raw)) return null
  const attrs = isObject(raw.object_attributes) ? raw.object_attributes : {}
  const project = isObject(raw.project) ? raw.project : {}
  const projectId = num(project.id) || num(attrs.project_id)

  if (event === EVENT_ISSUE) {
    if (str(attrs.action).toLowerCase() !== 'open') return null
    const iid = num(attrs.iid)
    if (iid === 0) return null
    return { triggerId: 'issue.opened', payload: { projectId, issueIid: iid, action: 'open' } }
  }

  if (event === EVENT_MR) {
    if (str(attrs.action).toLowerCase() !== 'open') return null
    const iid = num(attrs.iid)
    if (iid === 0) return null
    return { triggerId: 'mr.opened', payload: { projectId, mrIid: iid, action: 'open' } }
  }

  if (event === EVENT_PIPELINE) {
    // The receiver filters to failed at the boundary; re-assert here so the pure
    // mapper never emits a seed for a green/running pipeline (spec §4.4).
    if (str(attrs.status).toLowerCase() !== 'failed') return null
    const id = num(attrs.id)
    if (id === 0) return null
    return {
      triggerId: 'pipeline.failed',
      payload: {
        projectId,
        pipelineId: id,
        status: 'failed',
        ref: str(attrs.ref),
        sha: str(attrs.sha)
      }
    }
  }

  return null
}
