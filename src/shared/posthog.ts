/**
 * Shared PostHog-integration types (spec §4.2 shared row, §6.3). Kept in
 * `shared` because both the main-process connector and any future renderer
 * palette surface need the same vocabulary. No secrets ever live in these shapes
 * — the personal API key stays in the keychain (spec §8); config.json and these
 * types carry only non-secret references (project key, host) and normalized
 * analytics facts.
 *
 * The context-field PATHS (`event.*` / `insight.*` / `cohort.*` / `flag.*`) are
 * the CONTRACT the flow canvas palette and condition track read verbatim
 * (spec §6). `posthog-normalize.ts` is the single place a raw PostHog payload is
 * mapped into these shapes — numbers as numbers, booleans as booleans,
 * timestamps as ISO strings — so downstream edge conditions are deterministic
 * value compares (spec §6.3).
 */

/** The three POLLED triggers (spec §6.1). Not webhooks — each is backed by a
 *  poll strategy in `posthog-poller.ts` (spec §7). */
export type PostHogTriggerId = 'event.matched' | 'cohort.entered' | 'insight.threshold'

/** The four reads + the one gated write (spec §6.2). */
export type PostHogActionId =
  'queryEvents' | 'getInsight' | 'getFeatureFlag' | 'getCohort' | 'updateFeatureFlag'

/** A single normalized event (spec §6.3). `timestamp` is ISO 8601; `properties`
 *  is the raw property bag kept for templating. */
export interface PostHogEventContext {
  event: {
    id: string
    name: string
    distinctId: string
    timestamp: string
    properties: Record<string, unknown>
  }
}

/** A computed insight (spec §6.3). `value` is a NUMBER so `insight.value gt 5`
 *  compares numerically. */
export interface PostHogInsightContext {
  insight: {
    id: string
    name: string
    value: number
    unit?: string
    computedAt: string
  }
}

/** A cohort's current membership (spec §6.3). On a `cohort.entered` trigger the
 *  entering person's key is on the SeedEvent as `enteredDistinctId`. */
export interface PostHogCohortContext {
  cohort: {
    id: string
    name: string
    count: number
    enteredDistinctId?: string
  }
}

/** A feature flag's definition/rollout (spec §6.3). `active` is a BOOLEAN;
 *  `rolloutPercentage` is a NUMBER (or null when not a simple top-level rollout). */
export interface PostHogFeatureFlagContext {
  flag: {
    id: string
    key: string
    active: boolean
    rolloutPercentage: number | null
  }
}

/** The `posthog` block of config.json (non-secret refs only — spec §5, §8). The
 *  personal API key is NEVER here; it lives in the keychain. */
export interface PostHogConfig {
  enabled: true
  /** The public project key (`phc_…`) — identifies the project; NOT a secret. */
  projectApiKey: string
  /** Cloud-US / cloud-EU / self-host base URL — user-supplied → SSRF-guarded. */
  host: string
  /** Poll cadence in seconds; absent ⇒ the poller default (spec §7.3). */
  pollSeconds?: number
  /** Which localflow environment (1-9) hosts PostHog work. */
  environment: number
  /** Opt-in escape hatch for a self-hosted PostHog on a LAN/localhost (spec §4.4). */
  allowInsecureLocalHost?: boolean
}
