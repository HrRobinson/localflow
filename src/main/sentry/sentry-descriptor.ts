import type { IntegrationDescriptorDef } from '../../shared/integrations'
import {
  SENTRY_TRIGGER_IDS,
  SENTRY_READ_ACTION_IDS,
  SENTRY_MUTATION_ACTION_IDS
} from '../../shared/sentry'

/**
 * Sentry connector config surface (spec §8). Secret fields (`authToken`,
 * `webhookSecret`) route to the CredentialStore keychain and NEVER touch
 * config.json; non-secret refs (org/project slug, self-host baseUrl, environment,
 * ingress url) are config-as-code. Trigger/action ids are the pinned dev/incident
 * vocabulary (§6) the flow-templates track + the sibling GitHub node consume
 * verbatim — a snapshot test guards them. Mirrors `shopify-descriptor.ts`.
 */
export const sentryDescriptor: IntegrationDescriptorDef = {
  id: 'sentry',
  label: 'Sentry',
  configFields: [
    {
      key: 'authToken',
      label: 'Sentry auth token',
      secret: true,
      required: true,
      type: 'string',
      placeholder: 'sntrys_…'
    },
    {
      key: 'webhookSecret',
      label: 'Webhook Client Secret',
      secret: true,
      required: true,
      type: 'string'
    },
    {
      key: 'orgSlug',
      label: 'Organization slug',
      secret: false,
      required: true,
      type: 'string',
      placeholder: 'my-org'
    },
    {
      key: 'projectSlug',
      label: 'Project slug',
      secret: false,
      required: false,
      type: 'string',
      placeholder: 'my-project'
    },
    {
      key: 'baseUrl',
      label: 'Sentry base URL (self-host)',
      secret: false,
      required: false,
      type: 'string',
      placeholder: 'https://sentry.io'
    },
    {
      key: 'environment',
      label: 'localflow environment (1-9)',
      secret: false,
      required: true,
      type: 'number'
    },
    {
      key: 'webhookUrl',
      label: 'Ingress webhook URL',
      secret: false,
      required: false,
      type: 'string',
      placeholder: 'https://<tunnel>/sentry/webhook'
    }
  ],
  triggers: [
    { id: SENTRY_TRIGGER_IDS[0], label: 'New error issue' },
    { id: SENTRY_TRIGGER_IDS[1], label: 'A resolved error came back' },
    { id: SENTRY_TRIGGER_IDS[2], label: 'An issue-alert rule fired' }
  ],
  actions: [
    { id: SENTRY_READ_ACTION_IDS[0], label: 'Get an issue' },
    { id: SENTRY_READ_ACTION_IDS[1], label: "Get an event's stack trace" },
    { id: SENTRY_READ_ACTION_IDS[2], label: 'Search issues' },
    { id: SENTRY_MUTATION_ACTION_IDS[0], label: 'Resolve the issue' },
    { id: SENTRY_MUTATION_ACTION_IDS[1], label: 'Assign the issue' },
    { id: SENTRY_MUTATION_ACTION_IDS[2], label: 'Ignore / archive the issue' },
    { id: SENTRY_MUTATION_ACTION_IDS[3], label: 'Comment on the issue' }
  ]
}
