import { randomUUID } from 'node:crypto'
import type { LiveConnector } from '../../shared/integrations'
import { GITHUB_TRIGGER_IDS, type GitHubActionId, type GitHubTriggerId } from '../../shared/github'
import type { GitHubApi, RepoRef } from './github-api'
import {
  normalizeCheckRun,
  normalizeIssue,
  normalizePull,
  webhookToTrigger
} from './github-normalize'
import type { GitHubWebhookDelivery, GitHubWebhookServer } from './github-webhook-server'

/**
 * The GitHub `LiveConnector` (§4.2, §4.3) — the live dispatch behind the
 * registry's pinned `invokeAction`/`subscribe`. It maps a pinned action id → a
 * `github-api` call (isolating every GitHub shape there) and a pinned trigger id
 * → a shared-receiver subscription. It holds NO GitHub shape and NO secret:
 * reads normalize through `github-normalize.ts`, writes resolve the api client's
 * small result, and every failure REJECTS with the real GitHub cause (the pinned
 * convention) — never a token, never a sentinel-success (§6.2, §11).
 *
 * Authority stays in the graph: a mutation only runs because an `action` node
 * invoked it, behind whatever `gate`/edge the author drew (§9). The connector
 * NEVER auto-mutates — the webhook path only fans read-shaped `SeedEvent`s to
 * trigger handlers; it never calls a write. `mergePR` in particular is only ever
 * reachable through an explicit `invokeAction('mergePR', …)`; there is no
 * connector code path that merges on its own. This is the structural encoding of
 * "I merge PRs myself" (§9).
 */

const isTriggerId = (v: string): v is GitHubTriggerId =>
  (GITHUB_TRIGGER_IDS as readonly string[]).includes(v)

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export interface GitHubConnectorDeps {
  api: GitHubApi
  /** Config-default owner/repo; an action node may override per-node (§5). */
  defaultRepo?: Partial<RepoRef>
  webhook?: GitHubWebhookServer
  log?: (message: string) => void
}

export class GitHubConnector implements LiveConnector {
  private readonly api: GitHubApi
  private readonly defaultRepo: Partial<RepoRef>
  private readonly webhook?: GitHubWebhookServer
  private readonly log: (message: string) => void
  private readonly handlers = new Map<GitHubTriggerId, Set<(event: unknown) => void>>()
  private webhookWired = false

  constructor(deps: GitHubConnectorDeps) {
    this.api = deps.api
    this.defaultRepo = deps.defaultRepo ?? {}
    this.webhook = deps.webhook
    this.log = deps.log ?? ((m) => console.warn(m))
  }

  // ── Action dispatch ─────────────────────────────────────────────────────────

  async invokeAction(actionId: string, params: Record<string, unknown>): Promise<unknown> {
    switch (actionId as GitHubActionId) {
      // ── Reads (no gate — pure facts for conditions) ──
      case 'getIssue': {
        const repo = this.requireRepo(actionId, params)
        return normalizeIssue(
          await this.api.issue(repo, this.requireNumber(actionId, params)),
          repoStr(repo)
        )
      }
      case 'getPR': {
        const repo = this.requireRepo(actionId, params)
        return normalizePull(
          await this.api.pull(repo, this.requireNumber(actionId, params)),
          repoStr(repo)
        )
      }
      case 'getCheckRun': {
        const repo = this.requireRepo(actionId, params)
        return normalizeCheckRun(
          await this.api.checkRun(repo, this.requireNumber(actionId, params, 'id')),
          repoStr(repo)
        )
      }
      case 'searchIssues': {
        const query = requireString(actionId, params, 'query')
        const { items, total } = await this.api.searchIssues(query)
        return { items: items.map((i) => normalizeIssue(i)), count: total }
      }

      // ── Gated writes (run ONLY because an action node invoked them, §9) ──
      case 'commentIssue': {
        const repo = this.requireRepo(actionId, params)
        return this.api.createComment(
          repo,
          this.requireNumber(actionId, params),
          requireString(actionId, params, 'body')
        )
      }
      case 'labelIssue': {
        const repo = this.requireRepo(actionId, params)
        return this.api.addLabels(
          repo,
          this.requireNumber(actionId, params),
          requireLabels(actionId, params)
        )
      }
      case 'createIssue': {
        const repo = this.requireRepo(actionId, params)
        return this.api.createIssue(repo, {
          title: requireString(actionId, params, 'title'),
          body: optionalString(params.body),
          labels: optionalLabels(params.labels)
        })
      }
      case 'closeIssue': {
        const repo = this.requireRepo(actionId, params)
        return this.api.closeIssue(repo, this.requireNumber(actionId, params))
      }
      case 'openPR': {
        const repo = this.requireRepo(actionId, params)
        return this.api.createPull(repo, {
          head: requireString(actionId, params, 'head'),
          base: requireString(actionId, params, 'base'),
          title: requireString(actionId, params, 'title'),
          body: optionalString(params.body),
          draft: params.draft === true || params.draft === 'true'
        })
      }
      case 'dispatchWorkflow': {
        const repo = this.requireRepo(actionId, params)
        return this.api.dispatchWorkflow(repo, requireWorkflow(actionId, params), {
          ref: requireString(actionId, params, 'ref'),
          inputs: optionalInputs(params.inputs)
        })
      }
      case 'mergePR': {
        // The sharpest gated mutation (§9). Reached ONLY via an action node the
        // author placed behind a gate — the connector never merges on its own.
        const repo = this.requireRepo(actionId, params)
        return this.api.mergePull(repo, this.requireNumber(actionId, params), {
          method: optionalString(params.method),
          sha: optionalString(params.sha)
        })
      }

      default:
        throw new Error(
          `GitHub has no action '${actionId}'. Valid actions: getIssue, getPR, getCheckRun, ` +
            'searchIssues, commentIssue, labelIssue, createIssue, closeIssue, openPR, ' +
            'dispatchWorkflow, mergePR.'
        )
    }
  }

  // ── Param resolution ──────────────────────────────────────────────────────

  private requireRepo(actionId: string, params: Record<string, unknown>): RepoRef {
    const owner = optionalString(params.owner) ?? this.defaultRepo.owner
    const repo = optionalString(params.repo) ?? this.defaultRepo.repo
    if (!owner || !repo) {
      throw new Error(
        `GitHub action '${actionId}' needs an 'owner' and 'repo' — set the default repo in ` +
          'Settings or pass them on the node (e.g. owner:"acme", repo:"web").'
      )
    }
    return { owner, repo }
  }

  private requireNumber(actionId: string, params: Record<string, unknown>, key = 'number'): number {
    const raw = params[key]
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      throw new Error(
        `GitHub action '${actionId}' needs a positive '${key}' (e.g. "{{trigger.checkRun.prNumber}}").`
      )
    }
    return n
  }

  // ── Trigger subscription (webhook-backed) ────────────────────────────────────

  subscribe(triggerId: string, handler: (event: unknown) => void): () => void {
    if (!isTriggerId(triggerId)) {
      this.log(`github connector: ignoring unknown trigger '${triggerId}'`)
      return () => {}
    }
    let set = this.handlers.get(triggerId)
    if (!set) {
      set = new Set()
      this.handlers.set(triggerId, set)
    }
    set.add(handler)
    this.wireWebhook()
    return () => {
      set!.delete(handler)
    }
  }

  /** Attach the single webhook `onEvent` sink once, lazily on first subscribe. */
  private wireWebhook(): void {
    if (this.webhookWired || !this.webhook) return
    this.webhookWired = true
    this.webhook.onEvent((delivery) => this.onDelivery(delivery))
  }

  /** Verified, deduped delivery → normalized trigger payload → matching handlers.
   *  This path NEVER calls a write — a webhook only seeds a run (§9). */
  private onDelivery(delivery: GitHubWebhookDelivery): void {
    const result = webhookToTrigger(delivery.event, delivery.payload)
    if (!result) return
    const seed = { eventId: delivery.deliveryId || randomUUID(), payload: result.payload }
    for (const handler of this.handlers.get(result.triggerId) ?? []) handler(seed)
  }
}

function repoStr(repo: RepoRef): string {
  return `${repo.owner}/${repo.repo}`
}

function optionalString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function requireString(actionId: string, params: Record<string, unknown>, key: string): string {
  const v = params[key]
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`GitHub action '${actionId}' needs a non-empty '${key}'.`)
  }
  return v
}

function toLabels(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter((s) => s.length > 0)
  if (typeof v === 'string') {
    return v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  }
  return []
}

function requireLabels(actionId: string, params: Record<string, unknown>): string[] {
  const labels = toLabels(params.labels)
  if (labels.length === 0) {
    throw new Error(
      `GitHub action '${actionId}' needs one or more 'labels' (a name or a comma-list).`
    )
  }
  return labels
}

function optionalLabels(v: unknown): string[] | undefined {
  const labels = toLabels(v)
  return labels.length > 0 ? labels : undefined
}

function requireWorkflow(actionId: string, params: Record<string, unknown>): string {
  const raw = params.workflow ?? params.workflowId
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  if (typeof raw === 'string' && raw.length > 0) return raw
  throw new Error(
    `GitHub action '${actionId}' needs a 'workflow' (the file name e.g. "ci.yml" or its id).`
  )
}

function optionalInputs(v: unknown): Record<string, string> | undefined {
  if (!isObject(v)) return undefined
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v)) out[k] = String(val)
  return Object.keys(out).length > 0 ? out : undefined
}
