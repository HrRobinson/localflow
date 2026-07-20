import type { IntegrationDescriptorDef } from '../../../shared/integrations'

/**
 * PostHog connector config surface (spec §5, §6). The personal API key (`phx_…`)
 * is a SECRET → the CredentialStore keychain; the project key (`phc_…`, the
 * PUBLIC client key) and the host are non-secret refs → config.json (spec §8).
 * The host is user-supplied → run through the shared SSRF guard on every request
 * (spec §4.4). Field/trigger/action ids are the CONTRACT the flow engine/canvas
 * and the palette consume verbatim (spec §6) — a snapshot test guards them.
 */
export const posthogDescriptor: IntegrationDescriptorDef = {
  id: 'posthog',
  label: 'PostHog',
  configFields: [
    {
      key: 'personalApiKey',
      label: 'PostHog personal API key (phx_…)',
      secret: true,
      required: true,
      type: 'string'
    },
    {
      key: 'projectApiKey',
      label: 'Project API key (phc_…)',
      secret: false,
      required: true,
      type: 'string',
      placeholder: 'phc_…'
    },
    {
      key: 'host',
      label: 'PostHog host (https://…)',
      secret: false,
      required: true,
      type: 'string',
      placeholder: 'https://us.posthog.com'
    },
    {
      key: 'pollSeconds',
      label: 'Poll cadence (seconds)',
      secret: false,
      required: false,
      type: 'number',
      placeholder: '60'
    },
    {
      key: 'environment',
      label: 'localflow environment (1-9)',
      secret: false,
      required: true,
      type: 'number'
    }
  ],
  // POLLED triggers — not webhooks (spec §6.1, §7). Each is backed by a poll
  // strategy in `posthog-poller.ts` (timestamp cursor / set-diff / edge-cross).
  triggers: [
    { id: 'event.matched', label: 'New event matched a filter' },
    { id: 'cohort.entered', label: 'Person entered a cohort' },
    { id: 'insight.threshold', label: 'Insight crossed a threshold' }
  ],
  actions: [
    // Reads (no gate — pure reads write facts for conditions, spec §6.2).
    { id: 'queryEvents', label: 'Query events' },
    { id: 'getInsight', label: 'Get an insight' },
    { id: 'getFeatureFlag', label: 'Get a feature flag' },
    { id: 'getCohort', label: 'Get a cohort' },
    // The ONE gated write — runs ONLY because a flow action node reached it,
    // behind the author's gate (spec §6.2, §10).
    { id: 'updateFeatureFlag', label: 'Update a feature flag' }
  ]
}
