import { randomUUID } from 'node:crypto'
import type { LiveConnector } from '../../shared/integrations'
import type { GitLabApi } from './gitlab-api'
import type { GitLabWebhookEvent } from './gitlab-webhook-server'
import { normalizeIssue, normalizeMR, normalizePipeline } from './gitlab-normalize'

/**
 * The GitLab `LiveConnector` (spec §4.2) — the orchestrator the registry
 * delegates to for id `'gitlab'`. It owns:
 *  - the **action-dispatch table** (`invokeAction(actionId, params)` → the right
 *    `gitlab-api` call, normalized on the read side), and
 *  - **trigger fan-out** (`subscribe(triggerId, handler)` + `deliver(event)`): a
 *    verified webhook event routed to every handler subscribed to its trigger id
 *    as a `{ eventId, payload }` SeedEvent (the `trigger-subscriber` shape, §7).
 *
 * Safety posture (spec §9): the connector exposes five gated writes but NEVER
 * fires one on its own — a write runs ONLY because an action node invoked
 * `invokeAction`. Delivering a trigger makes ZERO GitLab writes. `mergeMR` has a
 * HARD FLOOR: it is REJECTED unless the run reached it through a gate (the author
 * must wire a gate/approval node's decision into the merge node's params), so
 * localflow never auto-merges ("I merge myself"). Every failure REJECTS with the
 * real `gitlab-api` error (spec §11); the PAT is confined to `gitlab-api`'s
 * `PRIVATE-TOKEN` header and never logged or returned.
 */

export interface GitLabConnectorDeps {
  api: GitLabApi
  /** Route+reason logger for delivery failures. NEVER receives a secret. */
  log?: (message: string) => void
  /** Injectable id minter for a SeedEvent lacking a delivery id (tests). */
  newId?: () => string
}

/** Read a required id param (`iid`/`id`), coerced to a string for the URL. */
function requireIid(params: Record<string, unknown>, action: string): string {
  const raw = params.iid ?? params.id
  if (typeof raw === 'string' && raw.length > 0) return raw
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  throw new Error(`GitLab ${action} needs a non-empty iid — none was supplied to the action.`)
}

function optionalStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** GitLab wants comma-joined labels on the issue endpoints. */
function labelsParam(v: unknown): string | undefined {
  if (typeof v === 'string' && v.length > 0) return v
  if (Array.isArray(v)) {
    const arr = v.filter((s): s is string => typeof s === 'string' && s.length > 0)
    return arr.length > 0 ? arr.join(',') : undefined
  }
  return undefined
}

export class GitLabConnector implements LiveConnector {
  private readonly api: GitLabApi
  private readonly log: (message: string) => void
  private readonly newId: () => string
  /** Per-trigger handlers (spec §7 fan-out). */
  private readonly handlers = new Map<string, Set<(event: unknown) => void>>()

  constructor(deps: GitLabConnectorDeps) {
    this.api = deps.api
    this.log = deps.log ?? ((m: string) => console.warn(m))
    this.newId = deps.newId ?? randomUUID
  }

  // ── Action dispatch (spec §6.2 reads, gated writes) ─────────────────────────

  // `async` so a synchronous validation throw (a missing id, the un-gated merge)
  // surfaces as a REJECTED promise — the pinned failure convention (spec §3, §11).
  async invokeAction(actionId: string, params: Record<string, unknown>): Promise<unknown> {
    switch (actionId) {
      // ── Reads (no gate — pure reads write facts for conditions, §6.2) ────────
      case 'getIssue':
        return normalizeIssue(await this.api.getIssue(requireIid(params, 'getIssue')))
      case 'getMR':
        return normalizeMR(await this.api.getMR(requireIid(params, 'getMR')))
      case 'getPipeline':
        return normalizePipeline(await this.api.getPipeline(requireIid(params, 'getPipeline')))
      case 'searchIssues': {
        const raw = await this.api.searchIssues({
          search: optionalStr(params.search),
          state: optionalStr(params.state),
          labels: labelsParam(params.labels)
        })
        const issues = Array.isArray(raw) ? raw.map((i) => normalizeIssue(i)) : []
        return { issues, count: issues.length }
      }

      // ── Gated writes (an action node reached them; §9) ───────────────────────
      case 'commentIssue':
        return this.api.createNote(
          requireIid(params, 'commentIssue'),
          optionalStr(params.body) ?? ''
        )
      case 'labelIssue':
        return this.api.updateIssue(requireIid(params, 'labelIssue'), {
          labels: labelsParam(params.labels) ?? ''
        })
      case 'createIssue': {
        const title = optionalStr(params.title)
        if (!title) {
          throw new Error('GitLab createIssue needs a non-empty title — none was supplied.')
        }
        const patch: Record<string, unknown> = { title }
        const description = optionalStr(params.description)
        if (description) patch.description = description
        const labels = labelsParam(params.labels)
        if (labels) patch.labels = labels
        return this.api.createIssue(patch)
      }
      case 'openMR': {
        const sourceBranch = optionalStr(params.sourceBranch)
        const targetBranch = optionalStr(params.targetBranch)
        if (!sourceBranch || !targetBranch) {
          throw new Error(
            'GitLab openMR needs a sourceBranch and a targetBranch — one was missing.'
          )
        }
        const patch: Record<string, unknown> = {
          source_branch: sourceBranch,
          target_branch: targetBranch,
          title: optionalStr(params.title) ?? `Merge ${sourceBranch} into ${targetBranch}`
        }
        const description = optionalStr(params.description)
        if (description) patch.description = description
        return this.api.createMR(patch)
      }
      case 'mergeMR': {
        // HARD FLOOR (§9): mergeMR NEVER auto-runs. It only runs when the run
        // reached it through a gate — the author wires the gate/approval node's
        // decision into this node's params. Absent that proof, REJECT before any
        // call, with the actionable §11 message.
        if (!isGated(params)) {
          throw new Error(
            'mergeMR must sit behind a gate — localflow will not auto-merge; ' +
              'add an approval node before it and wire its decision into the merge action.'
          )
        }
        return this.api.mergeMR(requireIid(params, 'mergeMR'), mergePatch(params))
      }

      default:
        throw new Error(
          `Unknown GitLab action "${actionId}" — the connector services getIssue, getMR, ` +
            `getPipeline, searchIssues, commentIssue, labelIssue, createIssue, openMR, mergeMR.`
        )
    }
  }

  // ── Trigger fan-out (spec §7) ───────────────────────────────────────────────

  subscribe(triggerId: string, handler: (event: unknown) => void): () => void {
    let set = this.handlers.get(triggerId)
    if (!set) {
      set = new Set()
      this.handlers.set(triggerId, set)
    }
    set.add(handler)
    return () => {
      set?.delete(handler)
    }
  }

  /**
   * Route a verified webhook event (from `gitlab-webhook-server`) to every handler
   * subscribed to its trigger id, as a `{ eventId, payload }` SeedEvent. This is
   * the ONLY path a trigger takes — it makes NO GitLab calls (authority: §9).
   */
  deliver(event: GitLabWebhookEvent): void {
    const set = this.handlers.get(event.triggerId)
    if (!set || set.size === 0) return
    const seed = { eventId: event.deliveryId ?? this.newId(), payload: event.payload }
    for (const handler of set) {
      try {
        handler(seed)
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        this.log(`gitlab connector: handler for ${event.triggerId} failed — ${reason}`)
      }
    }
  }
}

/**
 * The gate proof (§9): a truthy `approved` (or `gated`) param the author wires
 * from an upstream gate/approval node's decision. A trigger payload never carries
 * it, so a merge with no gate in front of it fails this check and is refused.
 */
function isGated(params: Record<string, unknown>): boolean {
  return params.approved === true || params.gated === true
}

/** Build the merge-request PUT body from optional merge params (§6.2). */
function mergePatch(params: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  if (typeof params.mergeCommitMessage === 'string') {
    patch.merge_commit_message = params.mergeCommitMessage
  }
  if (params.squash === true) patch.squash = true
  if (params.removeSourceBranch === true) patch.should_remove_source_branch = true
  return patch
}
