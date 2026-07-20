import type { IntegrationDescriptorDef } from '../../shared/integrations'
import {
  PAGERDUTY_TRIGGER_IDS,
  PAGERDUTY_READ_ACTION_IDS,
  PAGERDUTY_MUTATION_ACTION_IDS
} from '../../shared/pagerduty'

/**
 * PagerDuty connector config surface (spec §5, §8). Secret fields (`apiKey`,
 * `webhookSecret`, `routingKey`) route to the CredentialStore keychain and NEVER
 * touch config.json; non-secret refs (`fromEmail`, `region`, service/escalation
 * ids, ingress url, environment) are config-as-code. `region` is a validated enum
 * → a FIXED base URL, so there is no SSRF surface (§4.5). Trigger/action ids are
 * the pinned on-call vocabulary (§6) the flow-templates track + the sibling
 * Sentry/GitHub compose consume verbatim — a snapshot test guards them. Mirrors
 * `sentry-descriptor.ts`.
 */
export const pagerdutyDescriptor: IntegrationDescriptorDef = {
  id: 'pagerduty',
  label: 'PagerDuty',
  configFields: [
    {
      key: 'apiKey',
      label: 'PagerDuty REST API key',
      secret: true,
      required: true,
      type: 'string',
      placeholder: 'u+…'
    },
    {
      key: 'webhookSecret',
      label: 'Webhook v3 signing secret',
      secret: true,
      required: true,
      type: 'string'
    },
    {
      key: 'routingKey',
      label: 'Events API v2 routing key',
      secret: true,
      required: false,
      type: 'string'
    },
    {
      key: 'fromEmail',
      label: 'Acting user email (From)',
      secret: false,
      required: true,
      type: 'string',
      placeholder: 'localflow-automation@acme.com'
    },
    {
      key: 'region',
      label: 'Region (us / eu)',
      secret: false,
      required: true,
      type: 'string',
      placeholder: 'us'
    },
    {
      key: 'serviceId',
      label: 'Default service id',
      secret: false,
      required: false,
      type: 'string',
      placeholder: 'PXXXXXX'
    },
    {
      key: 'escalationPolicyId',
      label: 'Default escalation policy id',
      secret: false,
      required: false,
      type: 'string',
      placeholder: 'PXXXXXX'
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
      placeholder: 'https://<tunnel>/pagerduty/webhook'
    }
  ],
  triggers: [
    { id: PAGERDUTY_TRIGGER_IDS[0], label: 'Incident triggered (paged)' },
    { id: PAGERDUTY_TRIGGER_IDS[1], label: 'Incident acknowledged' },
    { id: PAGERDUTY_TRIGGER_IDS[2], label: 'Incident escalated' },
    { id: PAGERDUTY_TRIGGER_IDS[3], label: 'Incident resolved' }
  ],
  actions: [
    { id: PAGERDUTY_READ_ACTION_IDS[0], label: 'Get an incident' },
    { id: PAGERDUTY_READ_ACTION_IDS[1], label: 'Get a service' },
    { id: PAGERDUTY_MUTATION_ACTION_IDS[0], label: 'Acknowledge the incident' },
    { id: PAGERDUTY_MUTATION_ACTION_IDS[1], label: 'Resolve the incident' },
    { id: PAGERDUTY_MUTATION_ACTION_IDS[2], label: 'Escalate to the next on-call' },
    { id: PAGERDUTY_MUTATION_ACTION_IDS[3], label: 'Add a note to the incident' }
  ]
}
