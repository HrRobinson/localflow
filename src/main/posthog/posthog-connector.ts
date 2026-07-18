import type { LiveConnector } from '../../shared/integrations'
import type { PostHogApi, UpdateFeatureFlagPatch } from './posthog-api'
import type { PostHogPoller } from './posthog-poller'
import type { PostHogTriggerId } from '../../shared/posthog'
import type { SeedEvent } from '../flow/trigger-subscriber'
import {
  normalizeCohort,
  normalizeEvent,
  normalizeFeatureFlag,
  normalizeInsight
} from './posthog-normalize'

/**
 * The PostHog `LiveConnector` (spec §4.2) — the orchestrator the registry
 * delegates to for id `'posthog'`. It owns:
 *  - the **action-dispatch table** (`invokeAction(actionId, params)` → the right
 *    `posthog-api` call, `posthog-normalize` mapping the result), and
 *  - **trigger subscription** (`subscribe(triggerId, handler)` → registers a
 *    POLL subscription with `posthog-poller` and returns an unsubscribe that
 *    stops it — NOT a webhook, spec §7).
 *
 * Safety posture (spec §10): the connector exposes ONE gated mutation
 * (`updateFeatureFlag`) but NEVER fires it on its own — it runs ONLY because an
 * action node invoked `invokeAction`. Registering a poll subscription makes ZERO
 * PostHog writes. Every failure REJECTS with the real `posthog-api` error
 * (spec §11, the pinned convention); the personal API key is confined to
 * `posthog-api`'s Bearer header and never logged or returned.
 *
 * Live wiring (binding `posthog-api`'s `reveal` seam to the CredentialStore
 * plaintext exit + a real HTTP transport, and starting the poller's real cadence
 * timer) is DEFERRED (spec §4.3); this is the offline, mock-seam-tested core.
 */

export interface PostHogConnectorDeps {
  api: PostHogApi
  poller: PostHogPoller
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const TRIGGER_IDS: ReadonlySet<string> = new Set<PostHogTriggerId>([
  'event.matched',
  'cohort.entered',
  'insight.threshold'
])

/** Read a required id param (`insightId`/`cohortId`/`flagId`, falling back to
 *  `id`) — the `requireId` guard shape (`WoocommerceConnector`). */
function requireId(params: Record<string, unknown>, key: string, label: string): string {
  const raw = params[key] ?? params.id
  if (typeof raw === 'string' && raw.length > 0) return raw
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  throw new Error(`PostHog ${label} needs a non-empty ${key} — none was supplied to the action.`)
}

export class PostHogConnector implements LiveConnector {
  private readonly api: PostHogApi
  private readonly poller: PostHogPoller

  constructor(deps: PostHogConnectorDeps) {
    this.api = deps.api
    this.poller = deps.poller
  }

  // ── Action dispatch (spec §6.2 reads, §6.2 gated write) ─────────────────────

  // `async` so a synchronous validation throw (a missing id) surfaces as a
  // REJECTED promise — the pinned failure convention (spec §6.2) — never a sync
  // throw the action-runner would see out of band.
  async invokeAction(actionId: string, params: Record<string, unknown>): Promise<unknown> {
    switch (actionId) {
      case 'queryEvents': {
        const rows = await this.api.queryEvents({
          event: optionalStr(params.event),
          after: optionalStr(params.after),
          properties: isObject(params.properties) ? params.properties : undefined,
          limit: optionalNum(params.limit)
        })
        const events = rows.map((r) => normalizeEvent(r))
        return { events, count: events.length }
      }
      case 'getInsight':
        return normalizeInsight(
          await this.api.getInsight(requireId(params, 'insightId', 'getInsight'))
        )
      case 'getFeatureFlag':
        return normalizeFeatureFlag(
          await this.api.getFeatureFlag(requireId(params, 'flagId', 'getFeatureFlag'))
        )
      case 'getCohort':
        return normalizeCohort(await this.api.getCohort(requireId(params, 'cohortId', 'getCohort')))
      // ── The ONE gated write (author places a gate before this, spec §10) ─────
      case 'updateFeatureFlag': {
        const id = requireId(params, 'flagId', 'updateFeatureFlag')
        const patch: UpdateFeatureFlagPatch = {}
        if (typeof params.active === 'boolean') patch.active = params.active
        const rollout = optionalNum(params.rolloutPercentage)
        if (rollout !== undefined) patch.rolloutPercentage = rollout
        if (patch.active === undefined && patch.rolloutPercentage === undefined) {
          throw new Error(
            `PostHog updateFeatureFlag needs an 'active' boolean and/or a 'rolloutPercentage' number — neither was supplied.`
          )
        }
        return normalizeFeatureFlag(await this.api.updateFeatureFlag(id, patch))
      }
      default:
        throw new Error(
          `Unknown PostHog action "${actionId}" — the connector services queryEvents, ` +
            `getInsight, getFeatureFlag, getCohort, updateFeatureFlag.`
        )
    }
  }

  // ── Trigger subscription — a POLL, not a webhook (spec §7.1) ─────────────────

  /**
   * Start a persisted-cursor reconcile poll for this trigger. The flow trigger
   * node's `config` (insight id + threshold / cohort id / event filter) is read
   * by the poller when it registers the subscription. Returns an unsubscribe
   * that stops the poll. An unknown trigger id yields a no-op unsubscribe (the
   * opt-in default — nothing polls), keeping the pinned `subscribe(): () => void`.
   */
  subscribe(triggerId: string, handler: (event: unknown) => void): () => void {
    if (!TRIGGER_IDS.has(triggerId)) return () => {}
    // The trigger-subscriber passes the node's filter/config through; the poller
    // reads the trigger-specific keys from it. `subscribe` is called by
    // `subscribeTriggers`, which does not forward the node config today, so the
    // connector accepts a config-carrying handler shim: the poller pulls config
    // from the subscription registration. Here we register with an empty config
    // baseline; live wiring passes the node config via `subscribeWithConfig`.
    return this.subscribeWithConfig(triggerId as PostHogTriggerId, {}, (seed) => handler(seed))
  }

  /**
   * The config-aware subscription the live wiring uses (the trigger-subscriber
   * seam forwards the node config here). Kept separate from the pinned
   * `subscribe` so the `LiveConnector` signature stays byte-identical.
   */
  subscribeWithConfig(
    triggerId: PostHogTriggerId,
    config: Record<string, unknown>,
    handler: (event: SeedEvent) => void
  ): () => void {
    return this.poller.subscribe(triggerId, config, handler)
  }
}

function optionalStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function optionalNum(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return undefined
}
